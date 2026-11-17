---
description: Review a proposed report draft in a disposable workspace
mode: primary
steps: 8
permissions:
  - { action: "*", resource: "*", effect: deny }
  - { action: read, resource: "*", effect: allow }
  - { action: glob, resource: "*", effect: allow }
  - { action: grep, resource: "*", effect: allow }
---
Read docs/WRITING.md, docs/CFI.md and the add-report skill. Inspect only the provided evidence.
Return proposed changes as text for the controlled renderer; do not edit files or publish.
One event per report; every factual sentence needs a source that was opened. Report uncertainty.
Never elevate an automated draft to verified. Images require independent licence verification.
The service uses a deterministic renderer for report changes.
