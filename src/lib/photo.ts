import { UserFacingError } from './errors'

// Phone photos are 3–12 MB; this keeps the board readable for the AI at a few hundred KB
const MAX_SIDE = 1600
const QUALITY = 0.8

export interface CompressedPhoto {
  // Base64 without the data: prefix, as the API expects
  image: string
  mediaType: 'image/jpeg'
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      // Respects the EXIF rotation, so a portrait photo stays upright
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Older browsers: fall back to an <img>
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

// Scales the photo down to MAX_SIDE and re-encodes it as JPEG
export async function compressPhoto(file: Blob): Promise<CompressedPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new UserFacingError('Dit bestand is geen foto. Probeer het opnieuw.')
  }
  let source: ImageBitmap | HTMLImageElement
  try {
    source = await decode(file)
  } catch {
    throw new UserFacingError('Deze foto kon niet worden gelezen. Maak de foto opnieuw.')
  }
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width
  const height = 'naturalHeight' in source ? source.naturalHeight : source.height
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new UserFacingError('Deze foto kon niet worden verwerkt. Probeer het opnieuw.')
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  if ('close' in source) source.close()

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY)
  return { image: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' }
}
