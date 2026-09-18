/**
 * Project service – manages projects (placeholder for now).
 */

import type { Database } from "../../platform/database/database.js";
import type { Project } from "./project-types.js";

/**
 * Экспортируемый компонент или контракт модуля, доступный другим слоям приложения.
 */
export class ProjectService {
  constructor(private readonly db: Database) {}

  /**
   * Create a new project.
   */
  create(name: string, displayName: string): Project {
    return this.db.transaction((tx) => {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      tx.run(
        `INSERT INTO projects (id, name, display_name, status, created_at, updated_at)
         VALUES ($id, $name, $display_name, $status, $created_at, $updated_at)`,
        {
          id,
          name,
          display_name: displayName,
          status: "ACTIVE",
          created_at: now,
          updated_at: now,
        },
      );
      return { id, name, displayName, status: "ACTIVE", createdAt: now, updatedAt: now };
    });
  }
}
