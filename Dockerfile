# No build step and no dependencies: the image is the source plus a runtime.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY evals ./evals
COPY test ./test
# QA_TEST_MATRIX.md is not documentation ballast in the image: the verify step
# below reads it, because one test checks that the documented test count is the
# real one. Leaving it out fails the build.
COPY LICENSE README.md QA_TEST_MATRIX.md ./

ENV PORT=8080
EXPOSE 8080

# Fails the build if the tool surface breaks its published budgets.
RUN npm run verify

USER node
CMD ["node", "server.mjs"]
