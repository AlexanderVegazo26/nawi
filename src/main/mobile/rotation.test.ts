import { describe, expect, it } from 'vitest'
import { ANDROID_ORIENTATIONS } from '../../shared/flow/schema'
import { orientationOf, parseDisplayRotation, parseRotationSetting, restoreLine, rotationFor } from './rotation'

/** Roadmap M5d-4: the mapping between a flow's orientations and Android's quarter turns, and the settings it reads. */
describe('rotation', () => {
  const PHONE = { width: 1080, height: 2400 }
  const TABLET = { width: 2560, height: 1600 }

  it('maps each orientation to its own quarter turn and back, on a phone and on a landscape tablet', () => {
    for (const size of [PHONE, TABLET]) {
      const turns = ANDROID_ORIENTATIONS.map((o) => rotationFor(o, size))
      expect(new Set(turns).size, `${size.width}x${size.height}: four orientations, four rotations`).toBe(4)
      for (const o of ANDROID_ORIENTATIONS) expect(orientationOf(rotationFor(o, size), size), `${o} on ${size.width}x${size.height}`).toBe(o)
    }
    expect(ANDROID_ORIENTATIONS.map((o) => rotationFor(o, PHONE)), 'a phone stands in portrait').toEqual([0, 1, 2, 3])
    expect(ANDROID_ORIENTATIONS.map((o) => rotationFor(o, TABLET)), 'a tablet lies in landscape; portrait is a quarter turn back').toEqual([3, 0, 1, 2])
    expect(orientationOf(1, { width: 1600, height: 1600 }), 'a square screen counts as portrait').toBe('landscape')
    expect(orientationOf(4, PHONE)).toBeNull()
    expect(orientationOf(-1, PHONE)).toBeNull()
  })

  it('reads a rotation setting as its number, null when the device has none, and nothing it could not put back', () => {
    expect(parseRotationSetting('1\n', [0, 1])).toBe(1)
    expect(parseRotationSetting(' 3 \n', [0, 1, 2, 3])).toBe(3)
    expect(parseRotationSetting('null\n', [0, 1])).toBeNull()
    for (const junk of ['2\n', '', '10', '-1', 'Error: no such setting', '1; reboot'])
      expect(parseRotationSetting(junk, [0, 1]), JSON.stringify(junk)).toBeUndefined()
  })

  it('reads the quick look at the display\'s rotation in quarter turns, and nothing from other output', () => {
    expect(parseDisplayRotation('mDisplayRotation=ROTATION_0\n')).toBe(0)
    expect(parseDisplayRotation('mDisplayRotation=ROTATION_90\n')).toBe(1)
    expect(parseDisplayRotation('  winConfig={ mDisplayRotation=ROTATION_270 mWindowingMode=fullscreen')).toBe(3)
    for (const junk of ['', 'mDisplayRotation=undefined', 'mDisplayRotation=ROTATION_45', 'mDisplayRotation=ROTATION_900'])
      expect(parseDisplayRotation(junk), JSON.stringify(junk)).toBeNull()
  })

  it('puts a setting back with its old value, or deletes it when the device had none', () => {
    expect(restoreLine('user_rotation', 2)).toBe('settings put system user_rotation 2')
    expect(restoreLine('user_rotation', null)).toBe('settings delete system user_rotation')
  })
})
