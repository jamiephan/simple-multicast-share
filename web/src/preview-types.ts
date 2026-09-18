export type PreviewCategory =
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'text'
  | 'archive'
  | 'model'
  | 'office'
  | 'unknown'

export interface PreviewType {
  value: string
  label: string
  group: string
  category: Exclude<PreviewCategory, 'unknown'>
  extension: string
  mime?: string
}

export const previewTypes: PreviewType[] = [
  { value: 'text', label: 'Plain text / source code', group: 'Text', category: 'text', extension: 'txt', mime: 'text/plain' },
  { value: 'image-png', label: 'PNG image', group: 'Images', category: 'image', extension: 'png', mime: 'image/png' },
  { value: 'image-jpeg', label: 'JPEG image', group: 'Images', category: 'image', extension: 'jpg', mime: 'image/jpeg' },
  { value: 'image-gif', label: 'GIF image', group: 'Images', category: 'image', extension: 'gif', mime: 'image/gif' },
  { value: 'image-webp', label: 'WebP image', group: 'Images', category: 'image', extension: 'webp', mime: 'image/webp' },
  { value: 'image-svg', label: 'SVG image', group: 'Images', category: 'image', extension: 'svg', mime: 'image/svg+xml' },
  { value: 'audio-mpeg', label: 'MP3 audio', group: 'Media', category: 'audio', extension: 'mp3', mime: 'audio/mpeg' },
  { value: 'audio-wav', label: 'WAV audio', group: 'Media', category: 'audio', extension: 'wav', mime: 'audio/wav' },
  { value: 'audio-ogg', label: 'Ogg audio', group: 'Media', category: 'audio', extension: 'ogg', mime: 'audio/ogg' },
  { value: 'video-mp4', label: 'MP4 video', group: 'Media', category: 'video', extension: 'mp4', mime: 'video/mp4' },
  { value: 'video-webm', label: 'WebM video', group: 'Media', category: 'video', extension: 'webm', mime: 'video/webm' },
  { value: 'pdf', label: 'PDF document', group: 'Documents', category: 'pdf', extension: 'pdf', mime: 'application/pdf' },
  { value: 'archive-zip', label: 'ZIP archive', group: 'Archives', category: 'archive', extension: 'zip' },
  { value: 'archive-tar', label: 'TAR archive', group: 'Archives', category: 'archive', extension: 'tar' },
  { value: 'archive-tgz', label: 'TAR.GZ archive', group: 'Archives', category: 'archive', extension: 'tar.gz' },
  { value: 'archive-gz', label: 'GZip stream', group: 'Archives', category: 'archive', extension: 'gz' },
  { value: 'model-stl', label: 'STL model', group: '3D models', category: 'model', extension: 'stl' },
  { value: 'model-obj', label: 'OBJ model', group: '3D models', category: 'model', extension: 'obj' },
  { value: 'model-fbx', label: 'FBX model', group: '3D models', category: 'model', extension: 'fbx' },
  { value: 'model-gltf', label: 'glTF model', group: '3D models', category: 'model', extension: 'gltf' },
  { value: 'model-glb', label: 'GLB model', group: '3D models', category: 'model', extension: 'glb' },
  { value: 'office-docx', label: 'Word DOCX', group: 'Office', category: 'office', extension: 'docx' },
  { value: 'office-xlsx', label: 'Excel XLSX', group: 'Office', category: 'office', extension: 'xlsx' },
  { value: 'office-xls', label: 'Excel XLS', group: 'Office', category: 'office', extension: 'xls' },
  { value: 'office-pptx', label: 'PowerPoint PPTX', group: 'Office', category: 'office', extension: 'pptx' },
]

export function previewType(value: string) {
  return previewTypes.find((candidate) => candidate.value === value)
}
