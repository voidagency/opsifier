# Back up databases and whole servers

Opsifier backs up its managed databases, and the named volumes of apps, to a destination you choose, on a schedule or by hand. This guide sends Postgres, MySQL, MariaDB or MongoDB backups to an S3-compatible bucket, then shows how to download and restore them. The same steps work with the other destinations: a folder on the server, SFTP, FTP, or a cloud drive connected through your own OAuth app.

> **Early development.** Opsifier is not ready for production yet. Until it is, keep another copy of anything you can't afford to lose.

## What you need

- A bucket on any S3-compatible object store, and an access key that can list, read, write and delete files in it.
- A database service on the panel: see [Deploy your first app](FIRST-APP.md#connect-a-database). Redis has no backups.

## 1. Add the bucket as a destination

Under **Settings, Storage providers**, choose **Add**, then the kind of store. Several S3-compatible stores are listed by name, and **Generic S3** takes any other one. Fill in:

| Field             | What to enter                                                                     |
| ----------------- | --------------------------------------------------------------------------------- |
| Name              | How it appears in the list of destinations                                        |
| Access key ID     | From your storage account                                                         |
| Secret access key | Kept sealed on the server, and never shown again                                  |
| Bucket            | The bucket backups go into                                                        |
| Region            | The bucket's region                                                               |
| Endpoint          | The store's address. Required for Generic S3, optional for a store listed by name |
| Storage class     | Optional. Empty uses the bucket's default                                         |
| Prefix            | Optional. A folder inside the bucket that every file goes under                   |

Saving tries the connection first: the panel lists the bucket, writes a small file, reads it back and deletes it. A destination that saves is one that works. Its state stays on the list, and **Check now** tries it again.

## 2. Add a backup to the database

Open the database, then its **Backups** tab, and choose **Add backup**:

- **What it holds**: one database, the whole server with its users and roles, or the users and roles alone.
- **Database**: the database to copy, for a backup of one database.
- **Destination**: the bucket you just added.
- **Folder**: where the files go inside the destination.
- **Schedule**: a preset, such as daily at 2:00, or a cron expression, in the server's time zone.
- **On a schedule**: off means it only runs by hand.
- **Keep**: how many scheduled runs to keep. Manual backups and safety copies are never counted, and empty keeps them all.

If the panel was down at a scheduled time, the backup runs once when it comes back, never once per missed time.

## 3. Run it once

**Run now** starts a backup straight away. The **History** lists every run with its state, file, size and destination, and its output is one click away.

Each backup is an export made inside the database's own container: `pg_dump` for Postgres, `mysqldump` or `mariadb-dump` for MySQL and MariaDB, both compressed with gzip, and `mongodump` as a gzipped archive for MongoDB. Next to every file goes `<file>.manifest.json`, which names the format, the engine and its version, the size and the SHA-256. A panel with no record of a file can still check what it is.

Backup files are not encrypted by the panel, so choose a destination you trust with them.

## 4. Download or restore

From the history:

- **Download this file** fetches it from the destination, checks it against its recorded size and SHA-256, then sends it. Each download is written to the activity log.
- **Restore this backup** puts the tables and data the backup holds back into the database it came from, replacing the ones that are there now. Type the database's name to confirm. The panel downloads and verifies the file, then takes a safety copy of the current data on the server before anything changes. Postgres imports in one transaction, so a failed import changes nothing. For MySQL, MariaDB and MongoDB, a failed or cancelled import removes what it created and loads the safety copy back.

A restore needs the database to be deployed and running, and is refused while other work is in progress on it.

**Restore from a file** takes a backup the panel has no record of, for example one made by another panel: give its path inside the destination, and the manifest next to it is checked before anything changes.

## Back up volumes too

An app's named volumes are backed up the same way, from its **Storage** tab, under **Volume backups**. Files are read while the app runs, so a copy taken at a busy moment may not be consistent: stop the app first when it has to be exact. A volume restore stops the service only for the moment of the swap, and keeps the old contents in a folder next to the volume until you delete them.

## Back up the whole server

Under **Settings, Server, Server backup**, one switch backs up everything on the server every day: the panel's own state with its key, an export of every database server, taken the way a whole-server backup is in its **Backups** tab, and the files of every volume. It goes to an S3-compatible destination, or to the server's own disk, kept with [restic](https://restic.net): encrypted, deduplicated, and each run sends only what changed. Only the owner, and the administrators the owner lets manage the server, see this page.

1. Pick the destination, the time in UTC, and how many daily, weekly and monthly backups to keep. Turn it on and save.
2. The first save creates the repository at the destination, in `opsifier-server/`, and its **recovery key**, shown once. Keep it in a password manager, outside the server: without it no backup can be read, even by you. **Show the recovery key** shows it again once you have given your two-factor code, or your password.
3. Note the **repository** shown under **Rebuild this server elsewhere**. With the recovery key and the destination's access keys, it is all a new server needs.

**Back up now** runs one straight away, and **Backups kept** lists what the repository holds. Old backups are forgotten after each run, and their data is removed from the repository once a week.

A destination on the server's own disk does not survive the loss of the server. Use it to go back in time, and an S3-compatible one to survive a disaster.

## Restore a whole server

On a new server, the installer puts a server backup back, then installs the panel on it. The panel comes back with its accounts, settings, projects and volumes, then imports each database's export and deploys every service that was running.

As root on the new server (`sudo -i` first), with the repository and the keys of the old one:

```bash
export RESTIC_REPOSITORY='s3:https://s3.eu-west-3.amazonaws.com/my-bucket/opsifier-server'
read -rs RESTIC_PASSWORD && export RESTIC_PASSWORD
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=…
curl -fsSL https://raw.githubusercontent.com/voidagency/opsifier/main/scripts/install.sh | bash -s -- --restore
```

`read` waits for the recovery key: paste it and press Enter. It is not shown and stays out of the shell's history, and the keys reach the panel's container by name, so they never appear on a command line.

- `--snapshot <id>` takes an older backup. The ids are under **Backups kept**, and their first 8 characters are enough. The latest one is used otherwise.
- Install the version of Opsifier the old server ran, or a later one, with `--version <tag>`. The restore prints the version that server ran.
- A repository on the old server's own disk has to be copied to the new one first. `RESTIC_REPOSITORY` is then its path there.

What happens:

1. The image's `restore-backup` command downloads and decrypts the backup. It puts the panel's database, its `secret.key`, Traefik's certificates and every volume's files back in `/var/lib/opsifier`, and leaves each database's export in `/var/lib/opsifier/restore/dumps`.
2. Setup runs as usual and starts the panel on that state. Sign in with the old server's accounts.
3. The panel starts **Bring the server back from the backup**, under **Activity**. Each database's export is imported into a new volume, through a temporary server with no network, and the database is deployed onto it. Then every application that was running is deployed from its source, and any that failed is tried once more once the rest is up. **Settings, Server, Server backup** says how it went and lists anything that did not come back. An export that could not be imported stays in `restore/dumps`, and a volume that was already there is kept, never written to.

If the panel restarts in the middle, it carries on where it was, without importing a database twice. Then point your domains at the new server: the certificates come back with the backup, and renew as usual.

A server whose panel already has accounts is refused. With `--force`, that panel's state is moved into `/var/lib/opsifier/restore/previous-<time>` instead of being deleted, and the panel has to be stopped first, with `docker service scale opsifier=0`.

## What these backups don't cover

A database or volume backup holds that service and nothing else. The server backup holds the panel's own data as well, with `secret.key`: without that key, the secrets sealed in the panel's database can't be read.

The server backup leaves out a database that was stopped when it ran, since its export needs it running: start it, or back it up from its **Backups** tab. It also leaves out Redis data, and folders of the server that a bind mount reaches outside `/var/lib/opsifier`.
