# Globe Trotter — Claude Code Guidelines

## Agent Customizations & Single Source of Truth

All agent skills and rules for Globe Trotter are maintained in **[.agents/](file://./.agents/)**:

- **Skills**: [.agents/skills/](file://./.agents/skills/) (e.g., `globe-trotter-deploy`, `globe-trotter-yaml-config`, `globe-trotter-architecture`)

When performing tasks, read the relevant skill from `.agents/skills/<skill-name>/SKILL.md`.

---

## Environment & Build Rules

1. **Environment Setup**: Read `.env` variables (`FLEXDB_URL`, `GCP_PROJECT_DEV`, `GCP_PROJECT_PROD`, `GCS_BUCKET_DEV`, `GCS_BUCKET_PROD`, `GCS_CDN_HOST`, `GKE_CLUSTER_DEV`, `GKE_CLUSTER_PROD`).
2. **Build Commands**:
   - Web App Dev Server: `npm run dev`
   - Production App Build: `SINGLE=true npm run build`
   - Core Library Build: `npm run build:lib`
   - Synthetic Data Generator: `npm run generate`
   - Parquet Conversion Tool: `node scripts/parquet-to-flex.js <config.yaml>`
