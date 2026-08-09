'use strict';
// Reads a chosen CSV file into the textarea so the roster import works without
// multipart upload handling on the server (keeps the app dependency-free).
document.addEventListener('change', function (e) {
  if (!e.target || e.target.id !== 'csvfile') return;
  var file = e.target.files && e.target.files[0];
  if (!file) return;
  var reader = new FileReader();
  reader.onload = function () {
    var ta = document.getElementById('csvtext');
    if (ta) ta.value = String(reader.result || '');
  };
  reader.readAsText(file);
});
