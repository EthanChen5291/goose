<div align="center">

# goose

[![Builds](https://img.shields.io/badge/builds-web%20%C2%B7%20desktop%20%C2%B7%20unity-black.svg)](#quick-start)
[![Engine](https://img.shields.io/badge/charts-librosa%20audio%20analysis-green.svg)](#quick-start)
[![Tests](https://img.shields.io/badge/tests-make%20test-lightgrey.svg)](#quick-start)

</div>

<table>
  <tr>
    <td width="50%"><img src="docs/img/title.png" alt="Title screen"></td>
    <td width="50%"><img src="docs/img/islands.png" alt="The islands, on the flight from the menu to the map"></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/img/map.png" alt="The world map"></td>
    <td width="50%"><img src="docs/img/duel.png" alt="A duel"></td>
  </tr>
</table>

## Quick start

```sh
python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt
make web        # generate assets, then the Vite dev server
make play       # the desktop build (pygame), no generation step
make test       # Python and web suites
```
