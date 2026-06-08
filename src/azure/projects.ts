import { AzureClient } from './client';

export interface ProjectInfo {
  id: string;
  name: string;
}

export async function listProjects(client: AzureClient): Promise<ProjectInfo[]> {
  const conn = await client.get();
  const core = await conn.getCoreApi();
  const projects: ProjectInfo[] = [];
  let skip = 0;
  const top = 200;
  for (;;) {
    const batch = await core.getProjects(undefined, top, skip);
    if (!batch || batch.length === 0) break;
    for (const p of batch) {
      if (p.id && p.name) projects.push({ id: p.id, name: p.name });
    }
    if (batch.length < top) break;
    skip += top;
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  return projects;
}
