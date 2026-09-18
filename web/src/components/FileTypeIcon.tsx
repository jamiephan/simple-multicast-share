import {
  Box, File, FileArchive, FileAudio, FileCode2, FileImage, FileSpreadsheet,
  FileText, FileVideo, Folder, Presentation,
} from 'lucide-react'
import { fileVisualType, type FileVisualEntry } from '../file-list'

export function FileTypeIcon({ entry }: { entry: FileVisualEntry }) {
  const type = fileVisualType(entry)
  const className = `entry-icon ${type}`
  switch (type) {
    case 'folder': return <Folder className={className} />
    case 'image': return <FileImage className={className} />
    case 'audio': return <FileAudio className={className} />
    case 'video': return <FileVideo className={className} />
    case 'archive': return <FileArchive className={className} />
    case 'code': return <FileCode2 className={className} />
    case 'model': return <Box className={className} />
    case 'spreadsheet': return <FileSpreadsheet className={className} />
    case 'presentation': return <Presentation className={className} />
    case 'pdf':
    case 'word':
    case 'text': return <FileText className={className} />
    default: return <File className={className} />
  }
}
