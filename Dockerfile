FROM node:26-slim
WORKDIR /app

# No compiler toolchain needed: better-sqlite3 ships prebuilt binaries for
# linux-x64/arm64, and .npmrc skips the no-op node-gyp step npm would otherwise run.
# devDependencies are installed on purpose — tsc for the build below, and tsx +
# drizzle-kit for running migrations, seed, and create-admin inside the container.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

COPY . .
# Compiles to dist/ and copies the Nunjucks views alongside (see the build script).
RUN npm run build

# Set after `npm ci`, which would otherwise skip the devDependencies above.
ENV NODE_ENV=production

# Run as the unprivileged `node` user (uid 1000) the base image provides, not
# root, so a compromised app process can do as little as possible. It only needs
# to write the database, so data/ is all it owns. On the VPS, the host folder
# mounted there must be owned by uid 1000 too — see the README's deploy steps.
RUN mkdir -p data && chown node:node data
USER node

VOLUME /app/data
EXPOSE 6559
CMD ["node", "dist/index.js"]

# Not size-optimized (devDependencies stay installed) — a multi-stage build
# trimming them out is a reasonable later optimization, not needed at this
# app's scale.
