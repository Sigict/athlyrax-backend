# Do not deploy this branch

This branch prepares the persistent-storage migration only.

Do not merge or deploy it until:

- the current Render filesystem has been archived through paid shell access;
- the raw authentication files have been preserved;
- the persistent disk has been populated;
- the storage-ready marker has been created;
- `npm run check:storage-safety` returns `ATHLYRAX_STORAGE_SAFETY_OK`;
- both `global-owner` and `demo-company` have been verified.
