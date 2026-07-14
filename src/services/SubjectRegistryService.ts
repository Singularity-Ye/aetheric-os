import * as fs from "fs";
import * as path from "path";

export interface SubjectConfig {
  name: string;
  rootPath: string;
  pdfPath: string;
  mdPath: string;
  nodesPath: string;
  mocsPath: string;
  discoveryPath: string;
  cheatsheetPath: string;
  labPath: string;
}

export class SubjectRegistryService {
  /**
   * Scans the base path and lists all subdirectories as available subjects.
   * Resolves relative paths against the Obsidian vault root path if necessary.
   */
  static async scanSubjects(basePath: string, vaultRoot: string): Promise<string[]> {
    const resolvedBase = path.isAbsolute(basePath) 
      ? basePath 
      : path.join(vaultRoot, basePath);

    try {
      if (!fs.existsSync(resolvedBase)) {
        return [];
      }
      
      const files = await fs.promises.readdir(resolvedBase, { withFileTypes: true });
      return files
        .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith("."))
        .map(dirent => dirent.name);
    } catch (err) {
      console.error("Failed to scan subjects:", err);
      return [];
    }
  }

  /**
   * Validates and bootstraps the directory structure for a specific subject.
   * Creates missing directories on demand.
   */
  static async bootstrapSubject(basePath: string, subjectName: string, vaultRoot: string): Promise<SubjectConfig> {
    const resolvedBase = path.isAbsolute(basePath) 
      ? basePath 
      : path.join(vaultRoot, basePath);
      
    const subjectRoot = path.join(resolvedBase, subjectName);

    const config: SubjectConfig = {
      name: subjectName,
      rootPath: subjectRoot,
      pdfPath: path.join(subjectRoot, "各章节原始资料-pdf"),
      mdPath: path.join(subjectRoot, "原始资料-md"),
      nodesPath: path.join(subjectRoot, "关系图谱-节点内容"),
      mocsPath: path.join(subjectRoot, "Chapter-MOCs"),
      discoveryPath: path.join(subjectRoot, "知识发现报告"),
      cheatsheetPath: path.join(subjectRoot, "考前速记"),
      labPath: path.join(subjectRoot, "Lab")
    };

    // Ensure all directories in the configuration exist
    const dirsToCreate = [
      config.rootPath,
      config.pdfPath,
      config.mdPath,
      config.nodesPath,
      config.mocsPath,
      config.discoveryPath,
      config.cheatsheetPath,
      config.labPath
    ];

    for (const dir of dirsToCreate) {
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
        console.log(`Created Scriptorium folder: ${dir}`);
      }
    }

    return config;
  }
}
