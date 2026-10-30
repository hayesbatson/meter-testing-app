# Meter Testing App

Web app for Mid America Meter's water meter accuracy testing: jobs, work orders, AWWA pass/fail, client reports, and internal time tracking.

- Hosted with GitHub Pages at https://hayesbatson.github.io/meter-testing-app/
- Sign-in: Microsoft 365 (Mid America Meter accounts only)
- Data: SharePoint site "Meter Testing App" (https://midamericameter365.sharepoint.com/sites/Metertestingapp)

This repository holds only the app's code. No client data or passwords are stored here.

## For maintainers
- `index.html` is the whole app: Microsoft sign-in (MSAL), SharePoint storage through Microsoft Graph, and the screens.
- Open `index.html?mock` to try the screens without Microsoft. Everything stays in memory and is lost on reload.
- SharePoint lists: **MTA Jobs**, **MTA Meters** and **MTA Config**. Files: `MeterTestingApp/history`, `photos` and `backups` in the site's Documents library.
- `tools/convert_history.py` converts the old Access database into a history file that the app imports. Run it on a local machine and never commit its output.
