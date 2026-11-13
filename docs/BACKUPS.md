# Back up databases to S3-compatible storage

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

## What these backups don't cover

The panel's own data, in `/var/lib/opsifier`, is not part of any service backup. Back it up with the panel stopped, and keep `secret.key` with it: without that key, the secrets sealed in the database can't be read.
