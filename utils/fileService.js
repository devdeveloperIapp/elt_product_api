// services/fileService.js
const fs = require("fs");
const path = require("path");

class FileService {
  static ensureDirectoryExists(directoryPath) {
    if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
      console.log(`Directory created: ${directoryPath}`);
    }
    return directoryPath;
  }

  // static saveExcelFile(sourceName, fileName, fileBuffer) {
  //   try {
  //     // Create base directory
  //     const baseDir = path.join(process.cwd(), 'public', 'source_excel_files');
  //     this.ensureDirectoryExists(baseDir);

  //     // Create file path with source name as subfolder
  //     const sourceDir = path.join(baseDir, sourceName);
  //     this.ensureDirectoryExists(sourceDir);

  //     // Save file
  //     const filePath = path.join(sourceDir, fileName);
  //     fs.writeFileSync(filePath, fileBuffer);

  //     console.log(`File saved: ${filePath}`);
  //     return filePath;
  //   } catch (error) {
  //     throw new Error(`Failed to save file: ${error.message}`);
  //   }
  // }
  static saveExcelFile(sourceId,sourceName, fileName, fileBuffer,folderName='source_excel_files') {
    try {
      const baseDir = path.join(process.cwd(), "public", folderName);
      this.ensureDirectoryExists(baseDir);
 // 🔑 Use primary ID instead of sourceName
    const sourceDir = path.join(baseDir, String(sourceId)); //Using source name as folder name
    this.ensureDirectoryExists(sourceDir);
      // const sourceDir = path.join(baseDir, sourceName);
      // thi's.ensureDirectoryExists(sourceDir);
console.log("folderName",folderName)
      const filePath = path.join(sourceDir, fileName);
      fs.writeFileSync(filePath, fileBuffer);

      // ✅ Public URL (relative to /public) source_excel_files
      const publicUrl = `/${folderName}/${encodeURIComponent(
        sourceId
      )}/${encodeURIComponent(fileName)}`;

      console.log(`File saved: ${filePath}`);
      return { filePath, publicUrl };
    } catch (error) {
      throw new Error(`Failed to save file: ${error.message}`);
    }
  }

  static getExcelFilePath(sourceName, fileName) {
    return path.join(
      process.cwd(),
      "public",
      "source_excel_files",
      sourceName,
      fileName
    );
  }

  static deleteFile(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`🗑️ Deleted file: ${filePath}`);
      } else {
        console.log(`⚠️ File not found: ${filePath}`);
      }
    } catch (error) {
      console.error(`❌ Failed to delete file: ${filePath}`, error);
      throw new Error(`Failed to delete file: ${error.message}`);
    }
  }
}

module.exports = FileService;
