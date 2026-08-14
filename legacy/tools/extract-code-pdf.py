"""Extract the Blevins Administrative Code from its PDF into structured sections.

Kept because the JSON it produces is 107 sections of governing text whose
accuracy nobody can check by reading the JSON alone. The source PDF is not in
the repository, so this cannot be re-run here — it is committed as provenance,
and for whoever has to do this again when the Code is next reissued.

Run as:  python3 tools/extract-code-pdf.py <pdf> data/blevins-administrative-code.json
Needs:   pymupdf

Four things it works around, none of them obvious:

  1. The text is ragged-right. A wrapped line therefore ends wherever the next
     word stopped fitting, and horizontal position says nothing about whether a
     paragraph ended. Line *spacing* does: a wrap follows at ~17pt, a new
     paragraph at ~22pt.

  2. Consecutive list items sit ~16.5pt apart — tighter than a wrap — so
     spacing alone merges them. They are recognised by their markers instead.

  3. Some sections carry their "§" as a separate text element, a point below
     and left of the number. Two elements on one row look exactly like two
     columns, and five sections were swallowed into the one above them before
     this was caught — they never appeared as sections at all.

  4. Two pages use two columns, and the two uses are opposites. In §2.22 the
     columns continue one list (items 1-6 left, 7-10 right) and must be read a
     column at a time. In §1.04 they are a definitions table and must be read a
     row at a time, pairing each term with its definition. Reading either the
     wrong way produces fluent nonsense: "4. Regulatory certification;
     department head; or".
"""
import json
import re
import sys

import pymupdf

STEP = 19.0          # vertical step above which a new paragraph has begun
ROW_TOL = 4.0        # lines within this many points share a row
TERM_GAP = 13.0      # gap inside a wrapped table term vs. between terms
MARK = re.compile(r'^(?:§ \d|Chapter \d+\.|Article \d+\.|TITLE \d+|\d+\.\s|\([a-zA-Z0-9]+\)\s|[•·]\s)')


def furniture(s):
    if re.fullmatch(r'Blevins Holdings Administrative Code § \d+\.\d+', s):
        return True
    if 'clerk@blevinsholdings.com' in s:
        return True
    if re.fullmatch(r'BAC ?§ ?1\.01[–-]9\.09.*', s):
        return True
    if 'Confidential' in s and 'Internal Governance' in s:
        return True
    if re.sub(r'\s+', '', s).upper().startswith('—ENDOFTHE'):
        return True
    return False


def text_of(line):
    return "".join(s["text"] for s in line["spans"]).strip()


def merge_orphan_section_marks(lines):
    """Reattach a section mark that was set as its own text element.

    On the last page the "§" of §9.01, §9.02 and §9.03 is a separate element,
    a point below and to the left of its number. Two elements on one row looks
    exactly like two columns, so those three sections were fed through the
    column reader and came out buried inside §8.22 — the parser never saw a
    section mark at the start of a line, so they were not sections at all.
    """
    out, orphans = [], []
    for l in lines:
        (orphans if text_of(l) == '§' else out).append(l)
    for o in orphans:
        oy, ox = o["bbox"][1], o["bbox"][0]
        after = [l for l in out if abs(l["bbox"][1] - oy) <= ROW_TOL + 2 and l["bbox"][0] > ox]
        if not after:
            continue
        target = min(after, key=lambda l: l["bbox"][0])
        target["spans"] = [{"text": "§ "}] + list(target["spans"])
        target["bbox"] = (ox, target["bbox"][1], target["bbox"][2], target["bbox"][3])
    return out


def group_rows(lines):
    rows, i = [], 0
    lines = sorted(lines, key=lambda l: (round(l["bbox"][1], 1), l["bbox"][0]))
    while i < len(lines):
        y = lines[i]["bbox"][1]
        row = [l for l in lines[i:] if abs(l["bbox"][1] - y) < ROW_TOL]
        rows.append(row)
        i += len(row)
    return rows


def column_split(run):
    """Where the gutter falls, measured rather than assumed.

    The page midpoint is not it. §1.04's definition column starts at x=186 on a
    612pt page, so splitting at 306 puts both columns on the same side and the
    table reads as one mangled stream. The gutter is the widest gap between the
    left edges actually in use.
    """
    xs = sorted({round(l["bbox"][0], 1) for r in run for l in r})
    if len(xs) < 2:
        return xs[0] + 1 if xs else 0
    gaps = [(b - a, (a + b) / 2) for a, b in zip(xs, xs[1:])]
    return max(gaps)[1]


def table_paragraphs(run, mid):
    """A definitions table, read a row at a time: term, then its definition."""
    left = sorted([l for r in run for l in r if l["bbox"][0] < mid], key=lambda l: l["bbox"][1])
    right = sorted([l for r in run for l in r if l["bbox"][0] >= mid], key=lambda l: l["bbox"][1])

    # Terms wrap ("Administrative" / "Directive"), so gather each term from the
    # lines that sit tight against one another.
    terms = []
    for l in left:
        if terms and l["bbox"][1] - terms[-1][-1]["bbox"][1] <= TERM_GAP:
            terms[-1].append(l)
        else:
            terms.append([l])

    out = []
    for i, term in enumerate(terms):
        label = " ".join(text_of(l) for l in term).strip()
        start = term[0]["bbox"][1] - ROW_TOL
        end = terms[i + 1][0]["bbox"][1] - ROW_TOL if i + 1 < len(terms) else float('inf')
        body = " ".join(text_of(l) for l in right if start <= l["bbox"][1] < end).strip()
        if label.upper() == 'TERM' and body.upper() == 'DEFINITION':
            continue  # the table's own header
        if label or body:
            out.append(f"{label} — {body}" if body else label)
    return out


def page_paragraphs(page):
    lines = [l for b in page.get_text("dict")["blocks"] if b.get("lines") for l in b["lines"]]
    lines = [l for l in lines if text_of(l) and not furniture(text_of(l))]
    if not lines:
        return []
    lines = merge_orphan_section_marks(lines)
    rows = group_rows(lines)

    paras, cur, prev_y, run = [], "", None, []

    def flush_prose():
        nonlocal cur
        if cur:
            paras.append(cur)
            cur = ""

    def flush_run():
        nonlocal prev_y
        if not run:
            return
        mid = column_split(run)
        left_texts = [text_of(l) for r in run for l in r if l["bbox"][0] < mid]
        # Both columns carrying markers means one list split across them;
        # otherwise it is a table of terms and definitions.
        if left_texts and all(MARK.match(t) for t in left_texts):
            # Items wrap inside a column too — §2.22's item 9 runs onto
            # "department head; or". Emittingevery line as its own paragraph split
            # them, so a line without a marker rejoins the one above it.
            for side in (lambda x: x < mid, lambda x: x >= mid):
                col = sorted([l for r in run for l in r if side(l["bbox"][0])],
                             key=lambda x: x["bbox"][1])
                for l in col:
                    t = text_of(l)
                    if paras and not MARK.match(t) and col.index(l) > 0:
                        paras[-1] = paras[-1] + " " + t
                    else:
                        paras.append(t)
        else:
            paras.extend(table_paragraphs(run, mid))
        run.clear()
        prev_y = None

    for row in rows:
        if len(row) > 1:
            flush_prose()
            run.append(row)
            continue
        # A definition that runs past its term's last line leaves a row with
        # nothing in the left column. It still belongs to the table: treating
        # it as prose ended the run early and stranded "Company policy." as a
        # paragraph of its own.
        if run and row[0]["bbox"][0] >= column_split(run):
            run.append(row)
            continue
        flush_run()
        line = row[0]
        txt, y = text_of(line), line["bbox"][1]
        if cur and (MARK.match(txt) or (prev_y is not None and y - prev_y > STEP)):
            flush_prose()
        cur = (cur + " " + txt).strip() if cur else txt
        prev_y = y
    flush_run()
    flush_prose()
    return paras


def main(pdf_path, out_path):
    doc = pymupdf.open(pdf_path)
    paras = []
    for page in doc:
        paras.extend(page_paragraphs(page))
    body = "\n".join(paras)

    chap_at = {}
    for m in re.finditer(r'^Chapter (\d+)\.\s*(.+)$', body, re.M):
        chap_at[m.start()] = m.group(2).strip()

    secs = list(re.finditer(r'^§ (\d+\.\d+)\.\s+([^.]{2,90}?)\.\s+', body, re.M))
    marks = set(re.findall(r'^§ (\d+\.\d+)\.', body, re.M))
    if len(secs) != len(marks):
        raise SystemExit(f"parsed {len(secs)} sections but found {len(marks)} section marks")

    sections = []
    for i, m in enumerate(secs):
        end = secs[i + 1].start() if i + 1 < len(secs) else len(body)
        text = body[m.end():end].strip()
        text = re.sub(r'\n*(?:TITLE \d+ ·.*|Chapter \d+\..*|Article \d+\..*)$', '', text).strip()
        text = re.sub(r'^(?:TITLE \d+ ·.*|Chapter \d+\..*|Article \d+\..*)\n*', '', text).strip()
        chap = [v for k, v in sorted(chap_at.items()) if k < m.start()]
        sections.append({
            "citation": m.group(1),
            "title_num": m.group(1).split('.')[0],
            "chapter": chap[-1] if chap else None,
            "heading": m.group(2).strip(),
            "body_text": text,
        })

    json.dump({
        "code": "Blevins Administrative Code",
        "short_citation": "BAC",
        "citation_range": "BAC § 1.01–9.09",
        "effective_date": "2026-08-12",
        "adopted_by": "Board of Governors",
        "source": "BlevinsAdminCode.pdf (23pp), supplied 2026-08-14. Paragraphs recovered from "
                  "line spacing and structural markers; two-column lists read a column at a "
                  "time and the definitions table read a row at a time.",
        "sections": sections,
    }, open(out_path, "w"), indent=1, ensure_ascii=False)
    print(f"{len(sections)} sections -> {out_path}")


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
