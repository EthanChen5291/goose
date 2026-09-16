# goose — the things you actually run.
#
# The repo is two builds of one game: the pygame one you start with `make play`,
# and the web one you start with `make web`.  Both read the same charts, which
# Python generates; the web client only plays them, so anything that touches
# audio or art goes through `make assets` first.
.PHONY: help play web build test test-py test-web smoke assets assets-art assets-audio assets-data clean-cache

help:                     ## this list
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  %-14s %s\n", $$1, $$2}'

play:                     ## the desktop build
	python3 main.py

web: assets               ## the web client, on a dev server
	cd web && npm install && npm run dev

build: assets             ## the web client, built for deploying
	cd web && npm install && npm run build

test: test-py test-web    ## both suites

test-py:                  ## charting, rhythm, layout, the exporter's cuts
	python3 -m pytest

test-web:                 ## the judgment core, the coach, and desktop/web parity
	cd web && npx vitest run

smoke:                    ## drive a real browser through a run (needs `make build` first)
	cd web && npx vite preview --port 4173 & sleep 2; cd web && node tools/smoke.mjs; kill %1

assets: assets-art assets-audio assets-data  ## everything web/public/ is built from

assets-art:               ## sprites, effects, fonts and skies → web/public/px/
	python3 web/tools/pixel_pack.py

assets-audio:             ## synthesised effects → web/public/audio/sfx/
	python3 web/tools/sfx_gen.py

assets-data:              ## charts, songs, the theme, recorded effects, index → web/public/
	python3 web/tools/export_web.py

clean-cache:              ## drop the analysis and sprite caches (they rebuild, slowly)
	python3 -c "import shutil, userdirs; shutil.rmtree(userdirs.cache_dir(), ignore_errors=True); print('cache cleared')"
