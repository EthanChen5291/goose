from game.layout import Layout
from game import keyboard as KB


def test_layout_fills_the_window():
    L = Layout(1440, 900)                    # 16:10, taller than 16:9: fit the width, room on top
    assert abs(L.s - 0.75) < 1e-9
    assert L.ox == 0 and L.oy == 90
    assert L.X(0) == 0 and L.X(1920) == 1440
    assert L.Y(1080) == 900 and L.Y(L.top) == 0      # bottom-aligned, the grid reaches the top edge
    assert L.top == -120 and L.spawn_y == -180 and L.fall_px == L.slot_y + 180
    assert L.SCORE_POS == (40, -28) and L.ACC_POS == (1880, -28)
    L2 = Layout(2560, 1080)                  # wider: fit the height, columns at the sides
    assert L2.s == 1.0 and L2.oy == 0 and L2.left == -320 and L2.right == 2240
    L3 = Layout(1366, 1024, mode="letters")  # Letters centres its field
    assert abs(L3.top + L3.bottom - 1080) < 1e-6
    L4 = Layout(1920, 1080)
    assert L4.top == 0 and L4.left == 0 and L4.right == 1920 and L4.bottom == 1080


def test_noki_is_a_quarter_of_the_screen_in_the_left_column():
    L = Layout(1920, 1080)
    x, y, w, h = L.noki_rect
    assert h == 285 and w == 220
    assert x > 0 and x + w < 480


def test_noki_stands_on_the_slot_line():
    L = Layout(1920, 1080)
    x, y, w, h = L.noki_rect
    assert y + h == L.slot_y


def test_lanes_are_hand_zones():
    assert [KB.lane_of(c) for c in "qazwsx"] == [0] * 6
    assert [KB.lane_of(c) for c in "edcrfvtgb"] == [1] * 9
    assert [KB.lane_of(c) for c in "yhnujm"] == [2] * 6
    assert [KB.lane_of(c) for c in "ikolp"] == [3] * 5
    assert KB.hand_of("f") == 0 and KB.hand_of("j") == 1
    assert KB.MIRROR["f"] == "j" and KB.MIRROR["j"] == "f"
