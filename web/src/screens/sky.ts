/**
 * The sky, and the far backdrop under it.
 *
 * Out over the islands the sky is not a flat colour: a dome round the camera
 * carries a banded gradient — deep at the zenith, the island's own sky colour
 * across the middle, its haze at the horizon — stepped like the toon ramp and
 * dithered between the steps so it reads as pixel sky, with the sun as a hard
 * disc in a halo of rings, and stars coming out as the palette goes dark.  Below
 * the dome, at the horizon, a painted strip goes right round: a pixel-art
 * panorama of what is further off than anything built here — ranges, cities,
 * a storm front, the mainland — tinted by whatever island's light the drone is
 * in, and fading out at its top into the dome.
 */
import * as THREE from 'three'
import { OCEAN_Y, mixHex } from './island_kit'
import type { Palette } from './island_kit'

const hex = (c: number): THREE.Color => new THREE.Color(c)
/** the perceived brightness of a colour, 0..1 */
const lum = (c: number): number => (((c >> 16) & 255) * 0.3 + ((c >> 8) & 255) * 0.59 + (c & 255) * 0.11) / 255

export interface Sky {
  /** one frame: whether it shows, where the camera is, the light it is in, how far the whiteout has washed it */
  set: (on: boolean, from: THREE.Vector3, pal: Palette, sunDir: THREE.Vector3, wash: number) => void
}

export function buildSky(scene: THREE.Scene, root: THREE.Group, centre: THREE.Vector3, strip: string): Sky {
  // ── the dome ─────────────────────────────────────────────────────────────
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      top: { value: hex(0x4f9de8) }, mid: { value: hex(0x9ad4ff) }, low: { value: hex(0xd9eeff) },
      sunColor: { value: hex(0xfff1d6) }, sunDir: { value: new THREE.Vector3(0.51, 0.77, 0.38) },
      wash: { value: 0 }, night: { value: 0 }, sunK: { value: 1 },
      moonDir: { value: new THREE.Vector3(-0.55, 0.5, -0.67).normalize() },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 top, mid, low, sunColor, sunDir, moonDir;
      uniform float wash, night, sunK;
      varying vec3 vDir;
      float bayer(vec2 p) {
        // a 4×4 ordered dither, from the screen pixel
        ivec2 i = ivec2(mod(p, 4.0));
        int m[16]; m[0]=0; m[1]=8; m[2]=2; m[3]=10; m[4]=12; m[5]=4; m[6]=14; m[7]=6; m[8]=3; m[9]=11; m[10]=1; m[11]=9; m[12]=15; m[13]=7; m[14]=13; m[15]=5;
        return float(m[i.y * 4 + i.x]) / 16.0;
      }
      float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        // haze holds the first stretch above the horizon, the sky's own blue most of the way up, deepening only near the zenith
        float t = h < 0.18 ? (h / 0.18) * 0.45 : 0.45 + pow((h - 0.18) / 0.82, 2.2) * 0.55;
        const float STEPS = 9.0;
        t = floor(t * STEPS + bayer(gl_FragCoord.xy)) / STEPS;
        vec3 c = t < 0.45 ? mix(low, mid, t / 0.45) : mix(mid, top, (t - 0.45) / 0.55);
        // once it is dark: stars, thicker along a band across the dome, a crescent moon, an aurora low down
        if (night > 0.01) {
          vec3 cell = floor(d * 60.0);
          float s = hash(cell);
          float band = 1.0 - smoothstep(0.05, 0.22, abs(dot(d, normalize(vec3(0.3, 0.55, -0.78)))));
          float thresh = 0.988 - band * 0.05;
          float twinkle = step(thresh, s) * night * (0.55 + 0.45 * step(0.5, hash(cell + 1.0)));
          c = mix(c, vec3(1.0, 0.98, 0.9), twinkle * smoothstep(0.02, 0.2, h));
          c = mix(c, vec3(0.55, 0.6, 0.85), band * night * 0.14 * smoothstep(0.0, 0.25, h));
          float m = dot(d, moonDir);
          float bite = dot(d, normalize(moonDir + vec3(0.03, 0.012, 0.0)));
          if (m > 0.9992 && bite < 0.9992) c = mix(c, vec3(1.0, 0.97, 0.85), night);
          // the aurora: a curtain of green just up from the horizon, in strands
          float az = atan(d.z, d.x);
          float strand = step(0.45, fract(sin(floor(az * 40.0)) * 43.7));
          float curtain = smoothstep(0.02, 0.08, h) * (1.0 - smoothstep(0.12, 0.3, h)) * strand * night;
          c = mix(c, vec3(0.45, 0.95, 0.65), curtain * 0.3);
        }
        // the sun: a hard square-ish disc, a gap, then a ring of halo and a fainter one
        vec3 sr = normalize(cross(sunDir, vec3(0.0, 1.0, 0.0)));
        vec3 su = cross(sr, sunDir);
        vec3 off = d - sunDir * dot(d, sunDir);
        float sx = abs(dot(off, sr)), sy = abs(dot(off, su));
        float box = max(sx, sy);
        float s = dot(d, sunDir);
        if (s > 0.0 && box < 0.028) c = mix(c, vec3(1.0), 0.92 * sunK);
        else if (s > 0.0 && box > 0.038 && box < 0.05) c = mix(c, sunColor, 0.6 * sunK);
        else if (s > 0.0 && box > 0.062 && box < 0.07) c = mix(c, sunColor, 0.3 * sunK);
        c = mix(c, vec3(1.0), wash);
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  })
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2200, 24, 12), domeMat)
  dome.renderOrder = -1000
  dome.frustumCulled = false
  dome.visible = false
  scene.add(dome)

  // ── the strip: a cylinder round the whole world, its picture fading out at the top ──
  const R = 1350
  // four panels round, each 1024×432 of picture
  const H = (2 * Math.PI * R / 4) * 432 / 1024
  const tex = new THREE.TextureLoader().load(strip)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.magFilter = THREE.NearestFilter
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.wrapS = THREE.RepeatWrapping
  tex.repeat.x = -1
  const stripMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, fog: false, depthWrite: false, side: THREE.BackSide })
  const strip3 = new THREE.Mesh(new THREE.CylinderGeometry(R, R, H, 72, 1, true), stripMat)
  strip3.position.set(centre.x, OCEAN_Y - 2 + H / 2, centre.z)
  strip3.renderOrder = -900
  strip3.frustumCulled = false
  strip3.visible = false
  root.add(strip3)

  const u = domeMat.uniforms
  return {
    set: (on, from, pal, sunDir, wash) => {
      dome.visible = strip3.visible = on
      if (!on) return
      dome.position.copy(from)
      const dark = 1 - Math.min(1, Math.max(0, (lum(pal[0]) - 0.1) / 0.2))
      ;(u.top.value as THREE.Color).setHex(mixHex(pal[0], 0x1e4f9a, 0.12 * (1 - dark) + 0.15 * dark))
      ;(u.mid.value as THREE.Color).setHex(pal[0])
      ;(u.low.value as THREE.Color).setHex(mixHex(pal[1], 0xf9e0c0, 0.55 * (1 - dark)))
      ;(u.sunColor.value as THREE.Color).setHex(pal[3])
      ;(u.sunDir.value as THREE.Vector3).copy(sunDir)
      u.wash.value = wash
      u.night.value = dark
      u.sunK.value = 1 - dark * 0.8
      stripMat.color.setHex(mixHex(mixHex(0xffffff, pal[1], 0.55), 0xffffff, wash))
    },
  }
}
