# AlUla SC Official Match Centre

Bilingual (Arabic and English) match centre for the AlUla SC first team.

* `site/index.html` and `site/data.js`: the page, served by GitHub Pages.
* `scripts/update.mjs`: reads the Saudi Arabian Football Federation pages (standings and AlUla fixtures)
  and updates `site/data.js`. It never deletes a match, never blanks a score and never guesses a result.
* `.github/workflows/update.yml`: runs the update every 10 minutes, commits only when the data changed,
  and redeploys the page.

Run by hand: Actions tab, "Live update from SAFF", Run workflow.
Data source: saff.com.sa (all rights reserved by SAFF). Club crests belong to their clubs.
