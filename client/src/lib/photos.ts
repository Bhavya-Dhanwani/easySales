// Unsplash photos (free Unsplash licence), served by their CDN at the size we need
export const PHOTOS = {
  counter: 'photo-1556742049-0cfed4f6a45d',
  owner: 'photo-1531058240690-006c446962d8',
  shop: 'photo-1556740758-90de374c12ad',
  presenting: 'photo-1542744173-8e7e53415bb0',
  meeting: 'photo-1600880292203-757bb62b4baf',
  workshop: 'photo-1517048676732-d65bc937f952',
  laptop: 'photo-1484788984921-03950022c9ef',
  coffee: 'photo-1508766917616-d22f3f1eea14',
  tablet: 'photo-1543269664-56d93c1b41a6',
  team: 'photo-1573164574572-cb89e39749b4',
} as const

export const photo = (key: keyof typeof PHOTOS, w = 900, h?: number) =>
  `https://images.unsplash.com/${PHOTOS[key]}?w=${w}${h ? `&h=${h}` : ''}&q=75&auto=format&fit=crop`
