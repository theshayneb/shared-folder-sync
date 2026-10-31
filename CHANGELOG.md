# Changelog

## 0.2.0

- Multiple shares. Each share has its own name, folders, files and share
  code, so you can share different things with different people.
- Your mailbox now has an owner code, printed by `setup`, that lets the
  plugin create and delete shares. Share codes can't do either.
- People who join a share follow its folders and files when the owner
  changes them.
- Invites now carry the share's name.
- Settings and the 0.1.0 share code carry over. After updating the mailbox
  script, run `setup` once and redeploy a new version.

## 0.1.0

- First release: share one folder and single files through a Google Apps
  Script mailbox.
