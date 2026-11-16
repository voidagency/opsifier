# Run a database

Opsifier runs Postgres, MySQL, MariaDB, MongoDB and Redis as services of a project, each in its own container, with its data in a named volume. This guide adds one, connects an app to it, opens it to the outside when that is needed, and keeps it up to date.

> **Early development.** Opsifier is not ready for production yet. Keep backups of anything you put in it.

## Add a database

In a project, choose **Add service**, then **Postgres**, **MySQL**, **MariaDB**, **Mongo** or **Redis**. Everything except the name can be left empty:

- **Service name**: lowercase letters, digits, dashes and underscores, such as `db`.
- **Database name**: for Postgres, MySQL and MariaDB. Empty uses the project's name.
- **User**: empty uses the engine's usual account. Redis has a single account, `default`.
- **Password**: empty generates a strong one. MySQL and MariaDB also have a **Root password**.
- **Image**: a fixed version, such as `postgres:18.6`. `latest`, no tag, or a bare major such as `postgres:18` would move to a new version on its own at the next pull, under the data, so they are refused. A digest is accepted too.

The database starts deploying as soon as it is added.

| Engine   | Port inside the project | Data in the container      | Web admin tools         |
| -------- | ----------------------- | -------------------------- | ----------------------- |
| Postgres | 5432                    | `/var/lib/postgresql/data` | pgweb, DbGate           |
| MySQL    | 3306                    | `/var/lib/mysql`           | phpMyAdmin, DbGate      |
| MariaDB  | 3306                    | `/var/lib/mysql`           | phpMyAdmin, DbGate      |
| MongoDB  | 27017                   | `/data/db`                 | Mongo Express, DbGate   |
| Redis    | 6379                    | `/data`                    | Redis Commander, DbGate |

The database's **Overview** says which version it runs, and whether the server accepts its credentials: a process that has started and a server that lets you in are not the same thing.

## Connect an app

The database's **Credentials** tab shows how to reach it from its project: the user, the password, the database name, the internal host and port, and a ready-made connection URL. Revealing a password or a URL is written to the activity log, with who asked.

Copy the internal connection URL into the app's **Environment** tab, under the name the app reads, then deploy the app again:

```text
DATABASE_URL=postgresql://postgres:<password>@<internal host>:5432/demo
```

Services of the same project reach the database over the project's private network. Services in other projects, and everything outside the server, cannot, unless you expose it.

## Change the password

On the **Credentials** tab, **Change password** sets a new one, or generates it. The database applies it first, then the panel saves it: if the database refuses, nothing changes. MySQL and MariaDB can change the root password at the same time.

Apps keep the old password until you change their variables and deploy them again. If a change is interrupted halfway, the tab says so and offers to finish it.

## Reach it from outside

The **Expose** tab publishes the database's port on the server, for a tool on your computer or a service in another project. Choose a free port from 1024 to 65535, or 0 to stop exposing it. Saving only stores the port: redeploying the database opens it, and restarts the database.

The tab then shows an external host, port and connection URL. Anyone who can reach that port can try to connect, and bots look for open databases: keep a strong password, and limit who can reach the port with a firewall when you can.

## Browse it from a browser

The database's **Overview** has **Web admin tools**. **Enable** one, and it gets its own HTTPS address, with the sign-in name or access token it needs shown beside it. It can take a couple of minutes to be ready. **Disable** removes its address and leaves the data as it is.

## Change its version or settings

The **Advanced** tab holds what a database runs with:

- **Image**: a fixed version only. Moving to another major version, such as Postgres 17 to 18, may need the data to be migrated, so it is confirmed first, and backed up before it happens. A newer version proposed for new databases never changes a running one by itself.
- **Command**: runs with `/bin/sh -c` instead of the image's own start command. Empty keeps the image's. For Redis, keep the password in it:

```bash
redis-server --requirepass "$REDIS_PASSWORD" --maxmemory 256mb
```

- **Environment**: variables added to the engine's own, one `NAME=value` per line.
- **Config file**: for MySQL and MariaDB, kept beside the server's own configuration.

The **Resources** tab caps the memory and CPU a database may use, and sets aside what it must have. On both tabs, saving only stores the settings: redeploying applies them, and restarts the database.

## Back it up

The **Backups** tab exports Postgres, MySQL, MariaDB and MongoDB on a schedule or by hand, to a folder on the server, an S3-compatible bucket, SFTP, FTP or a cloud drive, and restores them. Redis has no backups. See [Back up databases and whole servers](BACKUPS.md).

## Remove it

**Destroy database**, under the database's **More actions**, removes the service, its web admin tools and its settings. Its data volume and its backups are kept: delete the volume later under **Monitor, Storage**. A new database never reuses an old volume.

## From a terminal

The same steps go through the API, so they can be scripted. See [the command line](CLI.md) and [the API](API.md).
