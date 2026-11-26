# Batch 2A1 complete score history

Feature scope: complete latest revision per exam, inclusive date bounds, existing category filtering, explicit same-student/same-subject custom comparison, raw scores and rate, 50-row accessible pagination independent of the full plot. No rank, schema, score payload, IPC or backend changes. Persisted old revisions remain intact; this does not add a revision-browser API.

Pure view filters do not write records. All raw values and exam identities are retained, same-day exams remain separate. Subject/category options are derived before date filtering so an empty date range never impersonates deletion of a subject. Actual disappearance still persistently clears the old category. Selection contains identity/revision only; out-of-scope choices are removed with a notice, edited choices use latest saved revision with notice, and a student change resets local controls without unmounting the detail tree.

Raw-score comparability is based on every participating exam, never only the visible list page. Different maxima use rate. Categories/difficulties do not imply ability or causal teaching improvement. The plot is an exam sequence ordered by exam date, not proportional calendar spacing.

Two existing truncation expectations are intentionally updated: 13 records now plot all 13, and the 20-record test starts at Nov 1 rather than Nov 9. Their full-history maximum validation and identity checks remain. Added relevant date/selection/large-set/pagination regressions; baseline tests remain. Original focused tests fail on the frozen baseline (12 versus 20/1000, unfiltered date/selection); implementation passes the new conditions.

Actual packaged acceptance extends score-acceptance with score-full-history: 71 math exams, 50/21 list pages with unchanged complete plot, date/category/custom selection, selected edit and notice, invalid range, raw-mode guard, no writes from filters and student-switch reset. The packaged renderer is used directly for these feature checks; development component injection remains only in the pre-existing isolated view-state test.

The branch is independently reviewed and does not alter frozen PR18. When stacked on the separately approved release-tooling branch, only this feature's UI/calculation/tests/docs appear in its diff; the tooling dependency prevents ordinary validation from uploading large artifacts. No merge or formal upgrade is performed. Rollback of this feature changes no stored schema or payload; any user-created score edits still remain as ordinary revisions.
