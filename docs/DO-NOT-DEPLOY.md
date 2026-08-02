# Do not deploy this branch

This branch prepares the persistent-storage migration only.

Do not merge or deploy it until:

- the existing API backup has a second independent copy;
- Render Support has confirmed in writing a way to preserve the currently running ephemeral filesystem without restarting or replacing the instance;
- the current Render filesystem has been archived and downloaded through that confirmed method;
- the archive checksum has been verified outside Render;
- the raw authentication files have been preserved;
- the persistent disk has been populated;
- the storage-ready marker has been created;
- `npm run check:storage-safety` returns `ATHLYRAX_STORAGE_SAFETY_OK`;
- both `global-owner` and `demo-company` have been verified.

Before the raw archive is safely preserved, do not:

- upgrade the service;
- restart or redeploy it;
- attach a persistent disk;
- change the start command;
- change environment variables;
- merge this PR.
