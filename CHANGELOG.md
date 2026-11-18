# Changelog

## 0.3.0

Stops your own devices from fighting over shared notes and settings when
they also use Obsidian Sync.

- **One device syncs.** A new **Run background tasks on this device** switch,
  saved on each device only, decides which device talks to the mailbox. It
  starts on for desktops and off for phones and tablets, which now get
  shared notes through Obsidian Sync. A phone or tablet without Obsidian Sync
  starts with it on.
- **Waits for Obsidian Sync.** Nothing automatic happens until Obsidian Sync
  has settled after a start or a wake from sleep and while other devices'
  changes are still arriving.
- **Merges instead of overwriting.** When two people change the same note,
  properties merge one by one and text merges line by line. Only a change to
  the same property or line is settled by the newer file time. An edit beats
  a delete. Needs the 0.3.0 mailbox script.
- **Sync progress stays on each device.** It moved out of data.json into the
  device's own storage and is saved only when it changes. data.json is no
  longer written while syncing.
- **Settings merge across devices.** Every share records when it was last
  edited, and deleted shares leave a marker, so a device with an old copy can
  no longer undo an edit, drop a share or bring a deleted one back. Settings
  arriving from another device are merged in straight away, and saved back
  only if that changed something. Typing in settings saves once you pause.
- **Status bar and Send changes now.** The always-on device shows how many
  changes are waiting to be sent. **Send changes now** skips the wait.
- Obsidian Sync's `(Conflicted copy …)` files are never shared.
- Upgrading: deploy the new `Code.gs` first, then update the plugin on every
  device. Shares, settings and sync progress carry over, including from a
  device still on 0.2.0.

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
