/**
 * Создаёт проекты и сохраняет их в базе данных.
 */

import type { Database } from "../../platform/database/database.js";
import type { Project } from "./project-types.js";

/**
 * Предоставляет публичный контракт модуля project-service для взаимодействия слоёв приложения.
 */
export class ProjectService {
  constructor(private readonly db: Database) {}

  /**
   * Создаёт активный проект с уникальным идентификатором и временными метками.
   *
   * Операция выполняется в транзакции; ошибки базы данных прерывают создание.
   * Вызывающий код отвечает за проверку допустимости имени и отображаемого имени.
   *
   * @param name Стабильное внутреннее имя проекта.
   * @param displayName Имя проекта для пользовательского интерфейса.
   * @returns Сохранённый проект со статусом `ACTIVE`.
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
