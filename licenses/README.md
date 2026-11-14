# Licenses of the programs in the image

The panel's image holds programs that are not Opsifier's: Node.js, restic, the Docker CLI with Buildx and
Compose, pack, Nixpacks and Railpack. Their licenses ask for their texts to travel with them, so each one's
license, and its NOTICE when it has one, is kept here as its project publishes it, and `programs.json`
lists them.

While the image is built, `apps/server/src/bootstrap/notices.ts` puts these texts together with those of
every JavaScript package the panel ships into `/usr/share/doc/opsifier/THIRD-PARTY-NOTICES.txt`, and the
list into `components.json`, which the About page shows.

When the Dockerfile adds a program, or changes the version of one, update `programs.json` and the texts:
a test holds the versions here to the ones the Dockerfile and the contract install.
