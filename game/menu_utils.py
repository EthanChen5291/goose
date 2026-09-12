"""
Utility functions and constants for the menu system.
Covers audio helpers, file picker, lyrics fetching, and JSON persistence.
"""
import os
import subprocess
import sys
import json
import re

_FONT = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "assets", "fonts", "tacobae-font", "Tacobae-pge2K.otf",
)


# ─── Audio duration helper ────────────────────────────────────────────────────

def _audio_duration(path: str) -> float | None:
    """Return duration in seconds, or None if it can't be determined."""
    try:
        import soundfile as sf
        return sf.info(path).duration
    except Exception:
        pass
    try:
        import librosa
        return librosa.get_duration(path=path)
    except Exception:
        pass
    return None


# ─── File picker (subprocess to avoid tkinter/pygame crash) ──────────────────

_PICK_SCRIPT = (
    "import sys, subprocess\n"
    "if sys.platform == 'darwin':\n"
    "    r = subprocess.run(\n"
    "        ['osascript', '-e',\n"
    "         'try\\n'\n"
    "         'set f to (choose file of type {\"mp3\", \"wav\"} with prompt \"Select an Audio File\")\\n'\n"
    "         'return POSIX path of f\\n'\n"
    "         'on error\\n'\n"
    "         'return \"\"\\n'\n"
    "         'end try'],\n"
    "        capture_output=True, text=True)\n"
    "    path = r.stdout.strip()\n"
    "    if path:\n"
    "        print(path)\n"
    "else:\n"
    "    import tkinter as tk\n"
    "    from tkinter import filedialog\n"
    "    root = tk.Tk()\n"
    "    root.withdraw()\n"
    "    root.attributes('-topmost', True)\n"
    "    root.update()\n"
    "    path = filedialog.askopenfilename(\n"
    "        title='Select an Audio File',\n"
    "        filetypes=[('Audio Files','*.mp3 *.wav'),"
    "                   ('MP3 Files','*.mp3'),('WAV Files','*.wav')])\n"
    "    root.destroy()\n"
    "    if path:\n"
    "        print(path)\n"
)


def pick_audio_file() -> str | None:
    """Blocking file picker (kept for legacy callers)."""
    try:
        result = subprocess.run(
            [sys.executable, "-c", _PICK_SCRIPT],
            capture_output=True, text=True, timeout=120,
        )
        path = result.stdout.strip()
        return path if path else None
    except Exception:
        return None


def start_pick_audio_file() -> subprocess.Popen:
    """Non-blocking file picker. Returns a Popen handle; poll with .poll() != None, then read .stdout.read().strip()."""
    return subprocess.Popen(
        [sys.executable, "-c", _PICK_SCRIPT],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )


# ─── Lyrics / word bank ──────────────────────────────────────────────────────

# fmt: off
_STOP_WORDS = {
    "the","a","an","is","are","was","were","be","been","being","have","has",
    "had","do","does","did","will","would","could","should","shall","may",
    "might","must","can","to","of","in","on","at","by","for","with","from",
    "up","about","into","through","during","before","after","above","below",
    "between","and","but","or","nor","so","yet","both","either","neither",
    "not","also","just","than","then","that","this","these","those","it",
    "its","itself","he","she","they","we","you","i","me","my","mine","us",
    "our","him","his","her","their","your","yours","what","which","who",
    "whom","when","where","why","how","all","each","every","few","more",
    "most","other","some","such","no","only","own","same","too","very",
    "s","t","ll","ve","d","m","re","oh","yeah","ooh","ahh","hey","la",
    "na","da","ba","uh","mm","hmm","gonna","wanna","gotta","cause","cos",
    "coz","ima","tryna","lemme","dont","doesnt","didnt","wont","wouldnt",
    "couldnt","shouldnt","cant","isnt","arent","wasnt","werent","ive",
    "youre","youve","youll","youd","hes","shes","weve","theyre","theyve",
    "theyll","thats","theres","lets","id","here","there","now","still",
    "even","back","down","over","out","off","away","around","again",
    "never","always","ever","like","get","got","give","go","come","know",
    "see","say","told","make","made","take","think","feel","want","need",
    "look","keep","hold","find","let","put","run","try","turn","move",
    "seems","said","came","went","left","right","way","time","day","night",
    "long","life","good","bad","old","new","big","own","little","world",
    "man","boy","girl","love","one","two","three","four","five","six",
    "seven","eight","nine","ten",
}
# fmt: on

DEFAULT_WORD_BANK: list[str] = [
    # animals / transport
    "dog","cat","fish","bird","cow","pig","mouse","horse","wing","animal",
    "train","plane","car","truck","bicycle","bus","boat","ship","tire","engine",
    "ticket","airport","bridge","hotel","farm","court","school","office",
    "room","town","club","bar","park","camp","store","shop","theater",
    "library","hospital","church","market","country","building","ground",
    "space","bank","location",
    # clothing
    "hat","dress","suit","skirt","shirt","pants","shoes","pocket","coat",
    "stain","clothing",
    # colors
    "red","green","blue","yellow","brown","pink","orange","black","white",
    "gray","color",
    # people / family
    "son","daughter","mother","father","parent","baby","woman","brother",
    "sister","family","husband","wife","king","queen","president","neighbor",
    "girl","child","adult","human","friend","victim","player","crowd",
    "person","teacher","student","lawyer","doctor","patient","waiter",
    "priest","police","army","soldier","artist","author","manager",
    "reporter","actor",
    # society / abstract
    "job","religion","heaven","hell","death","medicine","money","dollar",
    "bill","marriage","wedding","team","race","gender","murder","prison",
    "energy","peace","attack","election","magazine","newspaper","poison",
    "sport","exercise","ball","game","price","contract","drug","sign",
    "science","band","song","music","movie",
    # food / drink
    "coffee","tea","wine","beer","juice","water","milk","cheese","bread",
    "soup","cake","chicken","pork","beef","apple","banana","lemon","corn",
    "rice","oil","seed","knife","spoon","fork","plate","cup","breakfast",
    "lunch","dinner","sugar","salt","bottle","food",
    # home / objects
    "table","chair","bed","dream","window","door","bedroom","kitchen",
    "bathroom","pencil","pen","soap","book","page","key","paint","letter",
    "note","wall","paper","floor","ceiling","roof","pool","lock","phone",
    "garden","yard","needle","bag","box","gift","card","ring","tool",
    "clock","lamp","fan",
    # tech
    "network","computer","program","laptop","screen","camera","radio",
    # body
    "head","neck","face","beard","hair","eye","mouth","lip","nose","tooth",
    "ear","tear","tongue","back","toe","finger","foot","hand","leg","arm",
    "shoulder","heart","blood","brain","knee","sweat","disease","bone",
    "voice","skin","body",
    # nature
    "sea","ocean","river","mountain","rain","snow","tree","sun","moon",
    "world","earth","forest","sky","plant","wind","soil","flower","valley",
    "root","lake","star","grass","leaf","air","sand","beach","wave","fire",
    "ice","island","hill","heat","nature",
    # materials / measurement
    "glass","metal","plastic","wood","stone","diamond","clay","dust","gold",
    "copper","silver","material","meter","inch","pound","half","circle",
    "square","date","weight","edge","corner","map","vowel","light","sound",
    "piece","pain","injury","hole","image","pattern","noun","verb",
    "bottom","side","front","outside","inside","straight","north","south",
    "east","west","direction","summer","spring","winter","season",
    # verbs
    "work","play","walk","run","drive","fly","swim","stop","follow","think",
    "speak","eat","drink","smile","laugh","cry","buy","sell","shoot","learn",
    "jump","smell","hear","listen","taste","touch","watch","kiss","burn",
    "melt","explode","stand","love","cut","fight","dance","sleep","sing",
    "count","marry","pray","lose","stir","bend","wash","cook","open","close",
    "write","call","turn","build","teach","grow","draw","feed","catch",
    "throw","clean","find","push","pull","carry","break","wear","hang",
    "shake","beat","lift",
    # adjectives
    "long","short","tall","wide","narrow","large","small","little","slow",
    "fast","cold","warm","cool","young","weak","alive","heavy","dark","famous",
]


def _extract_notable_words(lyrics: str) -> list[str]:
    words = re.findall(r"[a-z]+", lyrics.lower())
    seen: set[str] = set()
    result: list[str] = []
    for w in words:
        if w not in seen and w not in _STOP_WORDS and 3 <= len(w) <= 9:
            seen.add(w)
            result.append(w)
    # sample evenly to target ~65 words
    if len(result) > 70:
        step = len(result) / 65
        result = [result[int(i * step)] for i in range(65)]
    return result


def _fetch_lyrics_words(artist: str, title: str) -> list[str]:
    """Fetch from lyrics.ovh and extract notable words. Returns [] on failure."""
    import urllib.parse, urllib.request
    try:
        url = (
            "https://api.lyrics.ovh/v1/"
            + urllib.parse.quote(artist.strip())
            + "/"
            + urllib.parse.quote(title.strip())
        )
        req = urllib.request.Request(url, headers={"User-Agent": "KeyDash/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        lyrics = data.get("lyrics", "")
        if not lyrics:
            return []
        words = _extract_notable_words(lyrics)
        # Require at least 15 distinct words — otherwise assume non-English / bad data
        return words if len(words) >= 15 else []
    except Exception:
        return []


# ─── Persistent song word-bank store ─────────────────────────────────────────

_WORD_BANK_FILE    = os.path.join("assets", "song_words.json")
_CUSTOM_SONGS_FILE = os.path.join("assets", "custom_songs.json")
_CUSTOM_BPMS_FILE  = os.path.join("assets", "custom_bpms.json")


def _load_custom_songs() -> list[str]:
    try:
        with open(_CUSTOM_SONGS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_custom_songs(names: list[str]) -> None:
    try:
        with open(_CUSTOM_SONGS_FILE, "w", encoding="utf-8") as f:
            json.dump(names, f, indent=2)
    except Exception:
        pass


def _load_custom_bpms() -> dict[str, int]:
    try:
        with open(_CUSTOM_BPMS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_custom_bpms(bpms: dict[str, int]) -> None:
    try:
        with open(_CUSTOM_BPMS_FILE, "w", encoding="utf-8") as f:
            json.dump(bpms, f, indent=2)
    except Exception:
        pass


def _load_word_banks() -> dict[str, list[str]]:
    try:
        with open(_WORD_BANK_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_word_banks(banks: dict[str, list[str]]) -> None:
    try:
        with open(_WORD_BANK_FILE, "w", encoding="utf-8") as f:
            json.dump(banks, f, indent=2)
    except Exception:
        pass


# ─── Per-song top-score persistence ──────────────────────────────────────────

_SCORES_FILE = os.path.join("assets", "scores.json")


def _load_scores() -> dict:
    try:
        with open(_SCORES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_scores(scores: dict) -> None:
    try:
        os.makedirs("assets", exist_ok=True)
        with open(_SCORES_FILE, "w", encoding="utf-8") as f:
            json.dump(scores, f, indent=2)
    except Exception:
        pass
