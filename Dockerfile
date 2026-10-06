# syntax=docker/dockerfile:1
# One image, two processes: the Next.js web app and the generation worker.
#   docker build -t ai-fantasy-studio .
#   docker run ... ai-fantasy-studio            (web, port 3000)
#   docker run ... ai-fantasy-studio npm run worker
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
# FFmpeg for assembly/QC; Noto fonts (incl. Noto Nastaliq Urdu) for burned-in Urdu subtitles.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-noto-extra ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
RUN useradd --system --uid 10001 studio && mkdir -p /app/storage /app/tmp && chown -R studio /app/storage /app/tmp
USER studio
EXPOSE 3000
CMD ["npm", "start"]
