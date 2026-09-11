"""
Keyboard geography: which hand, finger, lane and column a letter belongs to.

Lanes are the four hand zones of the Highway (left outer, left inner,
right inner, right outer).  Columns are the finger sub-columns inside a lane,
in design pixels relative to the lane centre.  Fingers are 0..9 left pinky to
right pinky.  Rows: 0 top, 1 home, 2 bottom.

Only QWERTY ships today; the tables are data so other layouts are a dict away.
"""
from __future__ import annotations

LANE_COLORS = {
    0: (255, 170, 241),   # L1 pink
    1: (255, 193, 142),   # L2 orange
    2: (142, 204, 255),   # L3 blue
    3: (142, 255, 194),   # L4 green
}
LANE_COLOR_NAMES = {0: 'pink', 1: 'orange', 2: 'blue', 3: 'green'}
GOLD = (255, 222, 123)
MISS_RED = (255, 96, 122)
INK = (11, 11, 18)

_QWERTY_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]

# finger index per key column (0..9), for the 10-column keyboard
_FINGER_BY_COL = [0, 1, 2, 3, 3, 6, 6, 7, 8, 9]
# lane per column
_LANE_BY_COL = [0, 0, 1, 1, 1, 2, 2, 3, 3, 3]
# finger sub-column offset (design px) per column, inside its lane
_COLUMN_OFFSET_BY_COL = [-40, 40, -64, 0, 64, -40, 40, -64, 0, 64]


def _build_tables() -> tuple[dict, dict, dict, dict, dict]:
    lane: dict[str, int] = {}
    finger: dict[str, int] = {}
    row: dict[str, int] = {}
    col_off: dict[str, int] = {}
    col_idx: dict[str, int] = {}
    for r, keys in enumerate(_QWERTY_ROWS):
        for c, ch in enumerate(keys):
            col = c if r == 0 else (c if r == 1 else c)   # rows are left-aligned; z is column 0
            col = min(col, 9)
            lane[ch] = _LANE_BY_COL[col]
            finger[ch] = _FINGER_BY_COL[col]
            row[ch] = r
            col_off[ch] = _COLUMN_OFFSET_BY_COL[col]
            col_idx[ch] = col
    # 'p' is column 9 on the top row; bottom row has 7 keys (z..m) => columns 0..6
    return lane, finger, row, col_off, col_idx


LANE_OF, FINGER_OF, ROW_OF, COLUMN_OFFSET_OF, COLUMN_OF = _build_tables()

HAND_OF = {ch: (0 if f <= 4 else 1) for ch, f in FINGER_OF.items()}   # 0 left, 1 right
FINGER_NAMES = ["left pinky", "left ring", "left middle", "left index", "left index",
                "right index", "right index", "right middle", "right ring", "right pinky"]
HOME_KEY_OF_FINGER = {0: 'a', 1: 's', 2: 'd', 3: 'f', 6: 'j', 7: 'k', 8: 'l', 9: ';'}
LEFT_HAND_LETTERS = "qwertasdfgzxcvb"
RIGHT_HAND_LETTERS = "yuiophjklnm"
MIRROR = {'a': ';', 's': 'l', 'd': 'k', 'f': 'j', 'g': 'h', 'q': 'p', 'w': 'o', 'e': 'i',
          'r': 'u', 't': 'y', 'v': 'm', 'b': 'n', 'c': ',', 'x': '.', 'z': '/'}
MIRROR.update({v: k for k, v in list(MIRROR.items()) if v.isalpha()})


def lane_of(ch: str) -> int:
    return LANE_OF.get(ch.lower(), 1)


def column_offset_of(ch: str) -> int:
    return COLUMN_OFFSET_OF.get(ch.lower(), 0)


def finger_of(ch: str) -> int:
    return FINGER_OF.get(ch.lower(), 3)


def hand_of(ch: str) -> int:
    return HAND_OF.get(ch.lower(), 0)


def row_of(ch: str) -> int:
    return ROW_OF.get(ch.lower(), 1)


def lane_color(lane: int) -> tuple[int, int, int]:
    return LANE_COLORS.get(lane, (255, 255, 255))


def hand_of_word(word: str) -> int | None:
    """0 if every letter is left-hand, 1 if every letter is right-hand, else None."""
    hands = {hand_of(c) for c in word if c.isalpha()}
    if len(hands) == 1:
        return hands.pop()
    return None
