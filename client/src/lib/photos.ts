// Unsplash photos (free Unsplash licence) about selling: calls, deals, founders, desks.
// Shown in a single forest/paper duotone (see <Photo>) so they read as one set.
export const PHOTOS = {
  call: 'photo-1758611974917-f7f7a58b74b0',
  call2: 'photo-1758873268528-af4613d099b6',
  call3: 'photo-1758876018582-e7573baf5306',
  deal: 'photo-1521791136064-7986c2920216',
  deal2: 'photo-1596633607590-7156877ef734',
  founder: 'photo-1758691737644-ef8be18256c3',
  founder2: 'photo-1758691737587-7630b4d31d16',
  writing: 'photo-1642522029686-5485ea7e6042',
  suit: 'photo-1758519288445-5847dd89f313',
  counter: 'photo-1556742049-0cfed4f6a45d',
  meeting: 'photo-1600880292203-757bb62b4baf',
  presenting: 'photo-1542744173-8e7e53415bb0',
  // kept for app screens
  owner: 'photo-1531058240690-006c446962d8',
} as const

export type PhotoKey = keyof typeof PHOTOS

export const photo = (key: PhotoKey, w = 900, h?: number) =>
  `https://images.unsplash.com/${PHOTOS[key]}?w=${w}${h ? `&h=${h}` : ''}&q=75&auto=format&fit=crop`

