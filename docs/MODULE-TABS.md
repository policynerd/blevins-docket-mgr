# Module tabs

Two separate bugs looked like one screenshot.

1. The top tab was labelled **Docket** and opened `/legislation`.
   Today’s meeting docket is `/docket` under Meetings. Clicking Docket
   and landing in the file list is the collision. The module is now
   **Legislation**. Today’s Docket stays under Meetings.

2. The selected tab was a white slab on a padded beige bar (`padding-top:6px`,
   `min-height:40px`). That is the raised rectangle in the screenshot.
   The bar is now one row high; the active tab sits on the bottom edge
   and erases the seam. No chamber display change.
