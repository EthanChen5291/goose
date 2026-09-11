"""
The word pool: common, fun, school-safe English words, 2–9 letters, with the
metadata the fitter scores on (length, attack letters, hand pattern).

A teacher's list always outranks the pool; the pool fills the lengths a list
is missing so the chart can match the song's accents instead of chopping words.
"""
from __future__ import annotations

from game import keyboard as KB

_RAW = """
go no me we up so do it in on at be by hi ok ax ox
cat dog sun run fun hop pop top zip zap bop tap rap map cap gap lap nap sap
bat hat mat rat sat pat fat vat wax fax tax max mix fix six kit bit hit sit
pit wit lit fit dip tip rip sip hip lip zip nip ink oak elk emu eel egg ice
ant ape bee bug cub cow fox hen jay owl pig ram yak kid pup cod eft doe ewe
red tan sky sea fog dew mud sod ivy fir elm bud pod nut jam pie tea egg ham
bun rye pea fig kiwi
cup mug pan pot lid jar tin bin bag box key pen pad rug mat bed cot fan lamp
car bus van jet cab sub ski sled raft boat kite drum bell horn harp flute
big wet dry hot old new raw odd shy sly wry coy icy fab rad gnarly
jog jump skip hop dash zoom roam hike swim dive glide float drift soar
now yes wow yay yum hey ooh aha zap pow bam boom bang ping pong
fun joy zen vibe glow gleam beam
moon star comet nova orbit rocket space cosmos planet galaxy meteor
cake pie jam tart bun roll wrap taco pizza pasta noodle salad soup stew
lime lemon mango peach grape melon berry apple cherry olive plum pear fig
mint sage basil thyme cocoa mocha latte
frog toad newt gecko koala panda lemur otter llama zebra tiger puma lynx
bison moose whale shark squid crab clam snail slug moth wasp bee ant flea
hawk crow dove wren finch robin swan goose duck crane heron egret stork
bear wolf lion deer boar hare mole vole mink lynx seal orca
oak ash elm fir yew pine palm cedar maple birch willow aspen
leaf root seed bud bloom petal stem vine moss fern reed
rain snow hail mist fog dew frost sleet storm gust wind breeze gale
lake pond creek brook river ocean bay cove reef tide wave surf foam
hill peak cliff ridge dune cave canyon valley meadow field prairie
gold jade opal ruby onyx pearl amber coral ivory bronze copper steel
pink teal aqua lime navy plum rust mauve sage rose gray blue cyan
song beat tune note chord hum drum bass riff tempo rhythm melody lyric
dance spin twirl hop step stomp sway bounce groove wiggle boogie
kick punch dodge block jab spin flip roll leap vault
robot laser pixel byte code data chip disk wire cable modem
dragon knight wizard castle sword shield quest magic spell potion
pirate island treasure compass anchor parrot cannon plank
ninja samurai karate sensei dojo
cookie candy fudge toffee mousse sundae waffle pancake muffin donut pretzel
bagel toast cereal yogurt cheese butter cream honey syrup
morning noon night dusk dawn today tonight week month year
spring summer autumn winter season
north south east west
happy silly funny goofy witty jolly merry cheery giddy lucky plucky
brave bold calm kind wise fair true keen neat tidy nimble swift
quick fast rapid speedy zippy snappy brisk
slow lazy sleepy dozy cozy snug warm mild soft
loud quiet hush whisper shout yell holler
tiny small wee mini micro nano giant huge vast mega jumbo
sharp blunt smooth rough bumpy fuzzy furry fluffy silky slick
bright shiny glossy sparkly dazzle shimmer glitter twinkle flicker
purple orange yellow violet indigo scarlet crimson silver golden
tickle giggle chuckle snicker guffaw cackle
mumble bumble tumble fumble rumble grumble jumble stumble
splash splat plop drip drop plunk clink clank clunk thud
crunch munch chomp gulp slurp sip nibble gobble
puzzle riddle secret mystery clue hint
pencil crayon marker eraser ruler paper notebook folder binder
button zipper pocket collar sleeve buckle
window mirror candle pillow blanket curtain carpet
garden meadow orchard forest jungle desert tundra swamp
bridge tunnel tower ladder rope chain gate fence
ticket ride train tram taxi ferry subway
camera photo video movie screen remote
pillow dream sleep snore yawn nap doze wake alarm
breeze thunder lightning rainbow sunset sunrise twilight
pepper salt sugar spice ginger garlic onion chili curry
waffle biscuit cracker pudding jelly
apron oven stove kettle spoon fork knife plate bowl
helmet goggles gloves boots scarf jacket
skate board scooter bike trike wagon cart
paint brush easel canvas sketch doodle
piano guitar banjo cello viola fiddle bugle tuba oboe
pixel sprite avatar level bonus combo streak
winner champ hero legend rookie captain
tackle sprint hurdle relay javelin marathon
pebble boulder gravel sand clay silt loam
acorn walnut peanut almond cashew pecan
caramel vanilla cinnamon nutmeg
kitten puppy bunny piglet duckling foal lamb cub calf chick
alpaca giraffe hippo rhino gorilla monkey lemur sloth
otter beaver badger weasel ferret hedgehog raccoon skunk
dolphin turtle lobster oyster jellyfish starfish seahorse
falcon eagle osprey pelican puffin parrot toucan flamingo
pumpkin turnip carrot radish celery lettuce spinach cabbage
mango papaya guava lychee durian coconut banana
velvet denim linen cotton wool satin
marble granite quartz crystal amethyst topaz
lantern torch beacon flare spark ember blaze flame
echo chorus verse bridge outro intro
tempo pause rest hold tap press strike
shadow silhouette shade shine gleam glint
whisper murmur mutter hum chant
zigzag spiral swirl curl loop twist
bubble balloon ribbon confetti streamer
juggle tumble cartwheel handstand somersault
compass map atlas globe chart
hammock tent cabin lodge igloo hut
kayak canoe yacht dinghy
comet asteroid nebula quasar pulsar
fossil amber relic ruin
cactus tumbleweed oasis mirage
avalanche blizzard glacier iceberg
volcano lava magma crater
hurricane cyclone tornado typhoon
"""

_STOP = set("ax ox eft ewe cod jay yak sod doe coy wry sly emu elk".split())


def _build_pool() -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for w in _RAW.split():
        w = w.lower().strip()
        if not w.isalpha() or w in seen or w in _STOP or not (2 <= len(w) <= 9):
            continue
        seen.add(w)
        out.append(w)
    return out


POOL: list[str] = _build_pool()
BY_LENGTH: dict[int, list[str]] = {}
for _w in POOL:
    BY_LENGTH.setdefault(len(_w), []).append(_w)

PLOSIVES = set("pbtdkg")
FRICATIVES = set("fsvzhx")


class WordInfo:
    __slots__ = ("text", "n", "plosive_mask", "hands", "fingers", "from_bank", "same_finger_pairs")

    def __init__(self, text: str, from_bank: bool = False) -> None:
        self.text = text
        self.n = len(text)
        self.plosive_mask = [c in PLOSIVES for c in text]
        self.hands = [KB.hand_of(c) for c in text]
        self.fingers = [KB.finger_of(c) for c in text]
        self.from_bank = from_bank
        self.same_finger_pairs = sum(1 for a, b in zip(self.fingers, self.fingers[1:]) if a == b)


def build_vocab(bank: list[str], use_pool: bool = True) -> dict[int, list[WordInfo]]:
    """Words by length: the teacher's list first, then the pool (deduplicated)."""
    vocab: dict[int, list[WordInfo]] = {}
    seen: set[str] = set()
    for w in bank:
        w = "".join(c for c in w.lower() if c.isalpha())
        if not w or w in seen:
            continue
        seen.add(w)
        vocab.setdefault(len(w), []).append(WordInfo(w, from_bank=True))
    if use_pool:
        for w in POOL:
            if w in seen:
                continue
            seen.add(w)
            vocab.setdefault(len(w), []).append(WordInfo(w))
    return vocab
