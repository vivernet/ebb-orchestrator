/**
 * Project domain types.
 */

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
