# Decisões — barreira entre setores, sessão entre abas e fotos

Execução subagent-driven da spec `docs/superpowers/specs/2026-10-15-visibilidade-e-fotos.md` (branch `feat/visibilidade-e-fotos`).
Revisão final aprovada; 5 ajustes menores aplicados. Servidor 531 testes, web 131, typecheck e build limpos.

- Ruling: Part 3 accepts only jpeg/png/webp/gif avatars (not any image/*) — SVG from our origin could run script — cost: none.
- Ruling: Part 4 user avatar file name is avatars/users/<id>-<base36 ts>.<ext> (cache-busting without updated_at column) — old file must be deleted on replace — cost: none.
- Ruling: PATCH user with role field resets seeAllSectors even if the role is unchanged — harmless (admin re-enables toggle) — cost: admin may need to re-enable "Ver todos" after editing himself in Atendentes.
