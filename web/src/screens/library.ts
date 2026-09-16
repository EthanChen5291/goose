/**
 * The user's own songs: import, storage, removal.
 *
 * The desktop build charts an uploaded file in-process (game/screens/file_upload_screen.py).
 * A browser cannot: the charting pipeline is librosa, scipy and numba, and none
 * of that runs in a tab.  So the seam is `web/tools/chart_file.py`, which charts
 * any local file into a bundle, and this screen imports that bundle together
 * with its audio.
 *
 * Audio lives in IndexedDB as a Blob — it is tens of megabytes and localStorage
 * caps out around five — and the charts live beside it in the same store.
 */

const DB_NAME = 'noki'
const DB_VERSION = 1
const STORE = 'songs'

export interface CustomSong {
  id: string
  title: string
  bpm: number
  duration: number
  /** "tier|mode" → the same shape as a shipped chart file */
  charts: Record<string, unknown>
  audio: Blob
  addedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    t.oncomplete = () => db.close()
  }))
}

export async function listCustomSongs(): Promise<CustomSong[]> {
  try {
    const all = await tx<CustomSong[]>('readonly', (s) => s.getAll() as IDBRequest<CustomSong[]>)
    return all.sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    return []
  }
}

export async function getCustomSong(id: string): Promise<CustomSong | null> {
  try {
    return (await tx<CustomSong>('readonly', (s) => s.get(id) as IDBRequest<CustomSong>)) ?? null
  } catch {
    return null
  }
}

export async function deleteCustomSong(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id) as unknown as IDBRequest<undefined>)
}

interface Bundle {
  bundle_version?: number
  title?: string
  audio_name?: string
  bpm?: number
  duration?: number
  charts?: Record<string, { song: { bpm: number; duration: number } }>
}

/** Read a bundle + audio pair into the store.  Throws with a readable message. */
export async function importSong(bundleFile: File, audioFile: File): Promise<CustomSong> {
  let bundle: Bundle
  try {
    bundle = JSON.parse(await bundleFile.text()) as Bundle
  } catch {
    throw new Error('That chart file is not readable JSON.')
  }
  if (!bundle.charts || !Object.keys(bundle.charts).length) {
    throw new Error('That file has no charts in it. Did you pick the .goosechart.json?')
  }
  if (bundle.bundle_version !== 1) {
    throw new Error(`This build reads bundle version 1, that file is version ${bundle.bundle_version}.`)
  }
  const first = Object.values(bundle.charts)[0]
  const song: CustomSong = {
    id: `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: bundle.title || audioFile.name.replace(/\.[^.]+$/, ''),
    bpm: bundle.bpm ?? first.song.bpm,
    duration: bundle.duration ?? first.song.duration,
    charts: bundle.charts,
    audio: audioFile,
    addedAt: Date.now(),
  }
  await tx('readwrite', (s) => s.put(song) as unknown as IDBRequest<IDBValidKey>)
  return song
}

/**
 * The import screen.  Two file pickers and the one command that produces the
 * chart file, because the alternative is a user wondering why their mp3 does
 * nothing on its own.
 */
export function buildImportScreen(
  onImported: () => void,
  onClose: () => void,
): HTMLElement {
  const el = document.createElement('div')
  el.className = 'overlay'
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-label', 'Add a song')
  el.innerHTML = `
    <div class="card import-card">
      <div class="label">Add a song</div>
      <p class="subtitle">Charting reads the whole waveform, which needs Python — it
        cannot run in a browser tab. Chart the song once on your machine, then bring
        both files here.</p>
      <pre class="cmd"><code>python3 web/tools/chart_file.py "your song.mp3"</code></pre>
      <p class="subtitle">That writes <code>your song.goosechart.json</code> next to the audio.</p>
      <div class="pickers">
        <label class="picker">
          <span>Audio file</span>
          <input type="file" id="imp-audio" accept="audio/*" />
        </label>
        <label class="picker">
          <span>Chart file</span>
          <input type="file" id="imp-chart" accept=".json,application/json" />
        </label>
      </div>
      <p class="err" id="imp-err" role="alert"></p>
      <div class="row" style="justify-content:center">
        <button class="play" id="imp-go" disabled>Add</button>
        <button class="chip" id="imp-close">Close</button>
      </div>
      <div id="imp-list"></div>
    </div>
  `
  const audioIn = el.querySelector('#imp-audio') as HTMLInputElement
  const chartIn = el.querySelector('#imp-chart') as HTMLInputElement
  const go = el.querySelector('#imp-go') as HTMLButtonElement
  const err = el.querySelector('#imp-err') as HTMLElement
  const list = el.querySelector('#imp-list') as HTMLElement

  const refresh = (): void => {
    go.disabled = !(audioIn.files?.length && chartIn.files?.length)
  }
  audioIn.onchange = refresh
  chartIn.onchange = refresh

  const paintList = async (): Promise<void> => {
    const songs = await listCustomSongs()
    if (!songs.length) { list.innerHTML = ''; return }
    list.innerHTML = `<div class="label" style="margin-top:22px">Your songs</div>`
    for (const s of songs) {
      const row = document.createElement('div')
      row.className = 'srow imported'
      row.innerHTML = `<span></span><button class="chip">Remove</button>`
      row.querySelector('span')!.textContent =
        `${s.title} · ${Math.round(s.bpm)} BPM · ${Object.keys(s.charts).length} charts`
      ;(row.querySelector('button') as HTMLButtonElement).onclick = async () => {
        await deleteCustomSong(s.id)
        await paintList()
        onImported()
      }
      list.appendChild(row)
    }
  }
  void paintList()

  go.onclick = async () => {
    err.textContent = ''
    go.disabled = true
    try {
      await importSong(chartIn.files![0], audioIn.files![0])
      audioIn.value = ''
      chartIn.value = ''
      await paintList()
      onImported()
    } catch (e) {
      err.textContent = e instanceof Error ? e.message : String(e)
    }
    refresh()
  }
  ;(el.querySelector('#imp-close') as HTMLButtonElement).onclick = onClose
  return el
}
