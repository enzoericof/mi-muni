import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const serverLibDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(serverLibDir, '../..')

const envFiles = ['.env.local', '.env']

for (const fileName of envFiles) {
  const filePath = path.join(projectRoot, fileName)
  if (existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false, quiet: true })
  }
}
