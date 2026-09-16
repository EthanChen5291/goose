import os
os.environ['SDL_MOUSE_FOCUS_CLICKTHROUGH'] = '1'

import pygame
import time as _time
from game.play import PlaySession
from game.models import Level
from game.menu import MenuManager
from game.menu_utils import _load_scores, _save_scores
from game.music import MusicManager


def _show_loading_screen(screen, clock, duration=0.35):
    """Brief petal-spinner transition shown when returning to the menu after a level."""
    import random as _random
    from game.ui_components import Petal
    sw, sh = screen.get_size()
    petals = [Petal(sw, sh, randomize_y=True) for _ in range(55)]
    # Override petal colors/alpha so they're clearly visible against the black background
    _bright_colors = [
        (255, 255, 255),
        (200, 220, 255),
        (255, 200, 240),
        (180, 240, 255),
        (255, 230, 200),
    ]
    for p in petals:
        p.alpha = _random.randint(90, 190)
        p.color = _random.choice(_bright_colors)
    start = _time.perf_counter()
    while True:
        elapsed = _time.perf_counter() - start
        if elapsed >= duration:
            break
        clock.tick(60)
        screen.fill((0, 0, 0))
        for p in petals:
            p.update()
            p.draw(screen)
        # Fade out only for last 0.15s (no fade-in so petals are visible immediately)
        if elapsed > duration - 0.15:
            fade_alpha = int(255 * (1.0 - (duration - elapsed) / 0.15))
            overlay = pygame.Surface((sw, sh), pygame.SRCALPHA)
            overlay.fill((0, 0, 0, fade_alpha))
            screen.blit(overlay, (0, 0))
        pygame.display.flip()
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                return
            
# TMW---

# while noki in middle, zoom camera in for zoom-in mode -> it hits and smooshes noki's face and stays in zoom-in mode

# BLITZ mode: on climax measures, have user type a full sentence with a timer. there are multiple sentences with their own timer.

# make the speed_hitmarker and slow_hitmarker animations (when played) very slightly taller and very slightly skinnier

# plan for repeat words 

# remove the hitsound whenever hold note finishes and the note is released. only play hitsound when initial press on hold note

# decrease drag on mouse but make the tail a bit sharper

# when leaving level, i just see a flash of the background (the bg petals) before the screen turns black to load for a few seconds. 
# I want the actual loading screen (the two petals petal1 petal2) rotating for however long is needed to load the main menu

# decrease glow of progress bar by 80% (nothing's changeed with previous alpha changes)

# -------

# make the hitmarker lerp a bit bigger upon note press correctly

# EFFECTS BRAINSTORMING

# REPEAT WORDS

# how should I ensure hitsound has a good volume given any song?

# calculate and record bpm ingame live -> return in finish menu

# firefly glowing around the mouse just like avesia 

# remove custom level button

# add title settings and level settings button

# shouldnt be able to press on buttons through the canon/custom menu

# noki_bop slightly lagging in loop?

# when scrolling down, begin lerp cropping the bottom of canon / custom tab up by up to 10% (not moving it all, just taking 3% off the bottom and adjusting text as needed)
# and move the horizontal line in which song names and stuff begin disappearing after scrolling down to the new point (where the bottom of canon/custom tab is)
# when scrolling back up and it reaches near the top, it begins lerp stretching again to reverse

# loading animation shouldn't completely stop when reaching the top -> only reach a pretty slow speed

# moreover make the impulse 20% more colored so that the pink, blue, and yellow (new one) colored ones that alternate between are more noticeable.

# end animation + remove word at end of level when typed

# support for different time signatures?

# rainbow bubble themed particles / outline on balls during some time?

# dual mode -> speed up or notes shows up at the end on the left and teleports to the right because dual mode ends.

# make screen "hits" where camera beats every other beat

# recreate speedup/slowdown/bounce mode/dual mode art

#speed up + bounce mode causes the timeline to go in the opposite direction (like timeline is going left and particles are coming from right)

# when in bounce mode and going in reverse, extend the timeline all the way to the left so they can see dots earlier before it comes

#make the .mov bop file png loop for transparency

# pink/light blue/ bubble colorset
# bounce mode section not having notes at all during semi-quiet sections (unsure why)
# can't scroll down in canon level menu with scroll bar

# whenever the session slows down at the end of the level, make sure the zoom stops zooming out after a bit (so it doesnt look like the timeline is being crunched into the hitmarker)

# animated timeline 
# animated circles + spin explode animation when pressed
# red circle animation for wrong

# cat hurt animation (red outline)



# DOUBLE TIMELINE mode timeline splits into two. has 1 second animation of the timeline splitting into two vertically (where one goes up and one goes down) so their vertical center was where the (default mode timeline was). there should be no notes for one measure during entrance just like dual mode
# - first timeline supports left side of keyboard, second timeline right side
# - during double timeline mode, movement is distinct. like it's not just oh you can type normally but 
# have to look at two timelines:
# - VERS 1: double timeline where one timeline is harmony (holding letters in 1-2 letter words for long time 
# while other timeline (otherside of keyboard) types words with letters only on that side). this means that two separate word lists going on for both 
# should alternate between timeslines (like timeline 1 does holding then timeline 2 does holding with word list adjusted 
# as appropriate to only include letters on the "not holding" side for the words)
# - VERS 2: same idea as VERS 1 except no holding. full words show up on each timeline (so not split letters of the same word list)
# where each word only has letters corresponding to its respective side of the keyboard

# SPEAK MODE: 
# uses AI to say the word (girl voice) -> noki meow animation.
# # user has word_duration amount of time to type the entire word, no beats just type it in x time.
# SYMBOL: volume symbol on timeline
# this leads timeline to fade away and noki to lerp to center and camera to zoom in on noki (noki bop 2 animation).
# when it's time for word, ensure word is at least 3 letters long and noki does noki_meow animation. 
# WAIT REAL ANIMATION: they speak, and when it's typed correctly, noki meows and gets rid of red spots crawling towards him (shockwavve)
# this repeats. speak mode has a cooldown AND SHOULD ONLY WORK WITH PARTS OF THE SONG (what parts?) and should last at least 3-4 measures (until the audio appears to "change section") 

# ADD 2 MORE CATS, each with their own hitmarker skin: 
# base cat (current cat) -> red skin. THREE LIVES, normal points
# female cat (white, slender, green eyes) -> (green hitmarker). TWO LIVES, 1.25x points multiplier
# chunk cat (nods head every 2 beats). FIVE LIVES, 0.75x points multipler, slows the song down 

# cat selection mode in main title screen with button under the cat
# incorporate the two cats into beginning animation

CANON_PATH = "assets/audios/canon/"
CUSTOM_PATH = "assets/audios/custom/"
SONG_NAMES = [
    "Scorpion.mp3",
    "Playful Massacre.mp3", 
    "Decisive Battle.mp3", 
    "Takedown - Huntrix.mp3", 
    "Glitch in your Heart.mp3", 
    "Disturbing the Peace.mp3", 
    "Catch Catch.mp3", 
    "Toby Fox - Finale.mp3",
    "ICARIUS.mp3",
    "Fluffing A Duck.mp3",
    "Malo Kart.mp3",
    "tidalwave.mp3",
    "hustle.mp3",
    "what is love?.mp3",
    "Chaos Construct.mp3",
    "Megalovania.mp3",
    "Miley Cyrus - Party In The U.S.A. (Official Video).mp3",
    "StoryOfMoon.wav",
    "Thee Sacred Souls - Can I Call You Rose.mp3",
    "Toby Fox - THE WORLD REVOLVING.mp3",
    "Waltz.mp3",
    "empty space - Flow 1.wav",
    "jester - Flow 1.wav",
    "noki_bamsam_file.wav",
    "noki_finalfight2v1 - Flow 1.wav",
    "noki_heartmetoo_file.wav",
    "noki_lastmeow_file.wav",
    "noki_ramjam_file.wav",
    "noki_strangeuwa_file.wav"
]

WORD_BANK_1 = ["cat", "test", "me", "rhythm", "beat", "fish", "moon", "derp", "noki", "yeah"]
WORD_BANK_2 = ["cat", "here", "me", "chosen", "beat", "hope", "soul", "true", "love", "stay"]


def main():
    pygame.init()
    info = pygame.display.Info()
    screen = pygame.display.set_mode((info.current_w, info.current_h), pygame.RESIZABLE)
    pygame.display.set_caption("goose")
    # macOS clamps the window under the menu bar after creation: let that settle so
    # every screen measures the real surface
    for _ in range(3):
        pygame.event.pump()
        pygame.time.wait(30)
    screen = pygame.display.get_surface() or screen
    clock = pygame.time.Clock()

    music = MusicManager()

    menu = MenuManager(screen, clock, SONG_NAMES, start_state="title", music=music)
    while True:
        result = menu.run()

        if result is None:
            break

        selected, difficulty, word_bank, bpm, mode = (list(result) + ["words"])[:5]

        song_name = SONG_NAMES[selected]
        _canon_path = CANON_PATH + song_name
        song_path = _canon_path if os.path.exists(_canon_path) else CUSTOM_PATH + song_name
        level = Level(
            word_bank=word_bank,
            song_path=song_path,
            difficulty=difficulty,
            bpm=bpm,
            mode=mode,
        )

        # ==========================TO DO LIST
        

        # make the mouse a circle (like osu?)

        # prevent freezing when uploading 
        # add loading screen when finishing level

        # hearts circle around the cat's neck -> when lose a life, one of the hearts flies to the hitmarker and becomes the hitmarker
        # 2 second cooldown -> hitmarker flashes during cooldown and fly to hitmarker animation plays. 
        # hitmarker is gray and skinny and then becomes the heart's color and becomes thicker and glows.

        # upon bounce, make the markers bend animation. same for speedups and slowdowns to a certain extent.
        
        # for repeat notes, make the word (like the word text itself) orange the first time and get marginally larger and swap colors between the colors of the impulse particles every time that word passes
    
        # remove signs 

        # add ghost notes?

        # make the purple more bluish (get hex)

        # add a hitsound whenever finishing a hold note

        # can add personality to songs by repeating word patterns for very difficult seuqneces

        # hold note -> noki meows to music for duration of hold note

        # don't repeat same letter if single letter

        # for the bounce mode mode -> reverse on arrows (bounces off of arrows and reverses) almost like going back in the timeline. the measure bars should also kinda accelerae backwards and reverse too. so not like a reverse, but almost like the hitmarker bounces off (so like momentum in the opposite direction with the measure and beat markers reflecting that)
        # don't move the hitmarker. 
        # make style
        # when skipping a word (like the word is gonna get cut off in the slot, add two "ghost words", blue circles (like sans's fake hits) where the player shouldn't press but complete the word)

        #save all the beatmaps manually of al the existing levels (so they don't have to load).
        # on pause screen, make the timeline and notes freeze not disappear
        # add restart button 

        #on simpler/calmer songs, don't just end words because the melody is slow/sparse, just drag it along for longer (ex. instead of givin "cat", "blob" "yeah" and cutting off half the words, just do "blob" and "cats"). if not many slots available.
        # for complex/faster/more pacey songs/sections, just add the blue stuff

        # on finish, add some finish thing for 2-3 seconds the open 'finish' menu
        
        # add some gradients in the background,
        # add PRESS note animation -> it fades into mist

        #make it to where, on wrong note, the next char isn't immediately deactivated.

        # some speed-ups seem to happen 

        # zoom in mode _> everything becomes bigger (including circles and timeline) -> what does this do? double timeline?

        #timeline rotate
        #EVENTUALLY
        # work on file system, saving files to cloud (so the files are there for that user every time, etc)
        #integrate font
        # doesn't understand climax sections well

        # ===== BUGS
        # doesn't wait until last char is finished in dual section before transitioning back
        # sometimes has ghost letters (skips on its own) (only bounce mode). 
        # sometimes doesn't have grace period when starting dual mode

        # Ariana Grande - Problem ft. Iggy Azalea 
        # words synced to song? is word detection from audio possible?

        # Inner replay loop — keeps replaying the same level until player exits
        while True:
            music.pause_for_game()
            game = PlaySession(level=level, screen=screen, clock=clock, music=music)
            game_result = game.run()
            music.resume_from_game()

            # Persist top score for this song + difficulty (normalized score; the
            # accuracy and grade of the best run ride along under "<difficulty>_stats")
            song_key = SONG_NAMES[selected]
            scores   = _load_scores()
            score_key = difficulty if mode == "words" else f"{difficulty}@{mode}"
            prev     = scores.get(song_key, {}).get(score_key, 0)
            if game.score > prev:
                scores.setdefault(song_key, {})[score_key] = game.score
                scores[song_key][score_key + "_stats"] = {
                    k: game.stats.get(k) for k in ("accuracy", "grade", "stars", "max_combo", "misses")
                }
                _save_scores(scores)

            if game_result != "replay":
                break

        _show_loading_screen(screen, clock)
        menu.reset_for_return("level_select")

    pygame.quit()


if __name__ == "__main__":
    main()
