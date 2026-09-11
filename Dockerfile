# ---- stage 1: build the React UI -------------------------------------------
FROM node:22-alpine AS ui
WORKDIR /ui
# Copy the manifests first so a source-only change reuses the install layer.
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- stage 2: the server ----------------------------------------------------
FROM python:3.12-slim

# Pillow only — everything else is stdlib. Wheels are prebuilt, so no compiler.
RUN pip install --no-cache-dir Pillow==11.3.0

# Runs unprivileged. The GID must match the `dvc` group that owns the data on
# the host, or the container cannot read the mounted disk. Override at build:
#   docker compose build --build-arg DVC_GID=$(getent group dvc | cut -d: -f3)
ARG DVC_GID=1500
RUN groupadd -g "${DVC_GID}" dvc \
    && useradd --system --uid 1500 --gid dvc --no-create-home browser \
    && mkdir -p /var/cache/thumbs && chown browser:dvc /var/cache/thumbs

COPY dataset_browser.py /app/dataset_browser.py
COPY --from=ui /ui/dist /app/web/dist

USER browser
ENV HOME=/var/cache PYTHONUNBUFFERED=1
EXPOSE 8800

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
    CMD python3 -c "import urllib.request,sys; \
    sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8800/api/versions',timeout=3).status==200 else 1)"

ENTRYPOINT ["python3", "/app/dataset_browser.py", "/data/datasets", \
    "--review", "/data/review", "--cache", "/var/cache/thumbs", \
    "--web", "/app/web/dist", \
    "--host", "0.0.0.0", "--port", "8800"]
