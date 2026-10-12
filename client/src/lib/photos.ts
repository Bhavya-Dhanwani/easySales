// Unsplash photos (free Unsplash licence) about selling: calls, deals, founders, desks.
// Served from /photos (public/photos, WebP): the site's security policy only allows its own images,
// and visitors aren't sent to a third party. Shown in one forest/paper duotone (see <Photo>).
// Each value is the photo's alt text, written from what the picture actually shows.
export const PHOTOS = {
  call: 'A smiling woman on a phone call at her desk at home, with a laptop and notebook',
  call2: 'A smiling woman in glasses on a phone call at a laptop in a busy office',
  call3: 'A woman in glasses explaining something on a phone call at her desk',
  deal: 'Close-up of two people in shirts shaking hands',
  deal2: 'Close-up of two hands in a firm handshake against a warm yellow background',
  founder: 'Portrait of a man in glasses and a beige blazer in an office',
  founder2: 'Portrait of a smiling woman with short blonde hair in an office',
  writing: 'A man in a suit on a desk phone, one hand on a page of handwritten notes',
  suit: 'A smiling man in a suit on a phone call, taking notes beside his laptop',
  counter: 'A shop owner at the till serving a smiling customer who pays by phone',
  meeting: 'Two colleagues high-fiving across a desk covered in reports',
  presenting: 'A man presenting to a team seated around a meeting table with laptops',
  owner: 'A florist working at the counter of her flower shop',
} as const

export type PhotoKey = keyof typeof PHOTOS

export const photo = (key: PhotoKey) => `/photos/${key}.webp`

// alt text for every photo, so screen readers describe what is shown
export const photoAlt = (key: PhotoKey) => PHOTOS[key]
