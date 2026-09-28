import { describe, expect, it } from 'bun:test'
import { validateReportText } from './index'

// validateReportText also enforces a 25-130 word range per paragraph, so every fixture
// is padded to a realistic length — otherwise a word_count issue masks what's under test.
const FILLER = 'The swell is pushing in at a steady clip and the sandbars are holding their shape well enough to give you something to work with on most sets today out there now.'
const para = (s: string) => `${s} ${FILLER}`
const codesFor = (text: string, localDate: string | null = null) =>
  validateReportText([para(text)], null, localDate).map(i => i.code)

// Each of these three rules lived in the prompt as prose and was audited against a pooled
// corpus of eval transcripts. The prose alone left a residue in every case; these are the
// gates that remove it. The percentages quoted are the measured residues.

describe('size_in_feet — the surf size must not be quoted in feet', () => {
  // Every upstream source reports significant wave height measured offshore, which is
  // smaller than the face a surfer rides. Measured 15% of reports before the prompt
  // stopped passing a height in feet, 0% of 278 after — this gate is the regression guard.
  it.each([
    'At 1.8 feet with that wind, it is mushy and gutless.',
    'but two-foot waves with that kind of short fetch go nowhere',
    'these little 1.8-foot waves have no juice',
    'two feet of short-interval chop will not excite anyone',
    '1.8 feet just does not have the juice to build anything',
    'we have got barely 2 feet of east swell running',
    'Expect 3 to 4 foot faces on the bigger sets.',
    'chest high, maybe a 5 footer on the sets',
    'solid 6ft waves out the back',
  ])('rejects %p', text => {
    expect(codesFor(text)).toContain('size_in_feet')
  })

  // Tide height, depth and distance are all legitimately measured in feet — the prompt
  // itself supplies the tide that way — so the unit alone can't decide.
  it.each([
    'The next high at 4:12 PM tops out at 4.8ft, so the bars will be covered.',
    'Tide is mid rising at 2.1ft and still filling.',
    'You will be standing in a few feet of water over the inner bar.',
    'The sandbar sits about 30 feet off the beach, past the shorebreak.',
    'The tidal range here is 10 feet, so timing matters more than anywhere else.',
    'Low tide leaves barely 2 feet of water over the bar.',
  ])('allows %p', text => {
    expect(codesFor(text)).not.toContain('size_in_feet')
  })

  it.each([
    'Waves are knee to waist high with the odd chest-high set.',
    'Overhead and clean, the best it has been all week.',
    'Shoulder to head high on the sets, dropping off between them.',
  ])('allows the body scale it is steering toward: %p', text => {
    expect(codesFor(text)).not.toContain('size_in_feet')
  })
})

describe('restated_orientation — the spot\'s cardinal orientation is not news', () => {
  // LOCAL KNOWLEDGE opens with it so the model can reason about swell and wind angles.
  // The prompt note took restatement from 18% of reports to 3.4%; this removes the rest.
  it.each([
    'The east-facing break is getting fed by an east swell today.',
    'The ENE angle is dialing in perfectly for our east-facing beach.',
    'This south-facing stretch picks up the swell well enough.',
    'The beach faces east, so that swell angle is about right.',
  ])('rejects %p', text => {
    expect(codesFor(text)).toContain('restated_orientation')
  })

  it.each([
    'The swell is coming in from the east at a workable angle.',
    'That east swell lines up with the outer bar nicely today.',
    'Wind is out of the west and holding the faces clean.',
  ])('allows talking about direction without restating orientation: %p', text => {
    expect(codesFor(text)).not.toContain('restated_orientation')
  })
})

describe('wrong_date — the named weekday must match Local Date', () => {
  const FRIDAY = 'Friday, August 28, 2026'

  it('rejects a weekday that is not today', () => {
    expect(codesFor('This is one of those Tuesday afternoons where you go anyway.', FRIDAY))
      .toContain('wrong_date')
  })

  it('allows the weekday that matches Local Date', () => {
    expect(codesFor('This is one of those Friday afternoons where you go anyway.', FRIDAY))
      .not.toContain('wrong_date')
  })

  it('is inert when no Local Date is supplied', () => {
    expect(codesFor('This is one of those Tuesday afternoons where you go anyway.'))
      .not.toContain('wrong_date')
  })

  // Month names are deliberately not gated: a forward-looking seasonal reference is not
  // a claim about what day it is, and both month mentions in the audited corpus were that.
  it('allows a forward-looking seasonal reference by month', () => {
    expect(codesFor('Come back when the nor\'easters start rolling in September.', FRIDAY))
      .not.toContain('wrong_date')
  })
})
