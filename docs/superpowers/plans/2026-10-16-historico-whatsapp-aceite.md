# Aceite manual: histórico do WhatsApp e sincronização

Roteiro do §11 da [especificação](../specs/2026-10-16-historico-whatsapp-design.md).

> ⚠️ Use só o **número de teste**. Ler o QR com o número do escritório o desconecta do Umbler Talk na hora.

## 0. Antes de começar

- [ ] Testes automáticos passando: `npm test`.
- [ ] Ambiente local rodando (README, "Rodar localmente") com o `docker-compose.dev.yml` desta entrega: `docker compose -f docker-compose.dev.yml --env-file .env.dev up -d --force-recreate evolution` e confira `docker compose -f docker-compose.dev.yml --env-file .env.dev exec evolution printenv DATABASE_SAVE_DATA_HISTORIC` → `true`.
- [ ] O celular de teste tem conversas com fotos e áudios recentes (menos de 3 semanas) e antigos, e pelo menos um contato que ainda não está no sistema.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

## A. Importação automática ao ler o QR

- [ ] Configurações › Canais: no canal de teste, **Período do histórico** = **3 meses**, **Gerar novo QR / Reconectar**. Aparece "Gerando QR code…" e, em seguida, o QR.
- [ ] Leia o QR. O status vira **Conectado** e aparece "Importando histórico… N mensagens", com N subindo.
- [ ] Em até ~15 minutos (10 minutos sem novidade) aparece "Histórico importado: N mensagens, desde DD/MM/AAAA", com a data por volta de 3 meses atrás.
- [ ] Clique de novo em **Importar histórico** enquanto uma importação roda: aparece "Já existe uma importação em andamento".

## B. Onde o histórico aparece

- [ ] Um contato **com telefone** e sem conversa aberta: na busca por nome/telefone (aba Finalizados com texto na busca) aparece a conversa; ela diz "Histórico importado do WhatsApp (só leitura)", sem **Reabrir**; a ficha do contato › "Todas as conversas deste contato" a lista.
- [ ] A aba **Finalizados** sem busca **não** mostra conversas de histórico.
- [ ] Um contato com conversa **aberta**: as mensagens antigas aparecem na conversa aberta, na ordem certa, e o contador de não lidas não mudou.
- [ ] Contatos **sem número** aparecem como "Contato sem número" (ou com o nome da agenda do celular).
- [ ] Entre com um atendente de outro setor: ele também vê a conversa de histórico.
- [ ] Nada entrou como **não lido**, nenhuma conversa foi para **Esperando**, nenhum chatbot nem triagem rodou (veja a linha do tempo: só "Histórico do WhatsApp importado: N mensagens").

## C. Mídia

- [ ] Fotos e áudios de menos de 3 semanas abrem (podem levar alguns minutos para baixar todos).
- [ ] Mídias mais antigas mostram "Arquivo não está mais disponível no WhatsApp", sem botão.
- [ ] Uma mídia com "mídia indisponível" tem o botão **Baixar**; clicar baixa (ou mostra o aviso de expirada).

## D. Recuperação com o app fora do ar

- [ ] Pare só o app (`Ctrl+C` no `npm run dev`), deixe a Evolution rodando.
- [ ] Do outro celular, mande 3 mensagens para o número de teste ao longo de **40 minutos**.
- [ ] Religue o app. As mensagens que chegaram há mais de 30 minutos aparecem em até 5 minutos, como histórico (sem não lidas, sem chatbot). As mais recentes chegam pelo webhook normalmente.

## E. Canal desconectado

- [ ] No celular de teste, remova o aparelho em **Aparelhos conectados**.
- [ ] Como admin, depois de 1 minuto, a caixa de entrada mostra "Canal <nome> desconectado: leia o QR code em Configurações › Canais". O link abre Configurações › Canais.
- [ ] Como atendente, a faixa não aparece.
- [ ] Leia o QR de novo: a faixa some e uma nova importação automática começa.

## F. Mais de um canal

- [ ] Crie um segundo canal (não precisa conectar). Os cartões da caixa de entrada passam a mostrar o nome do canal.

## Resultado

- Data: ________ · Quem testou: ________ · Versão: ________
- [ ] Aprovado  [ ] Reprovado — o que falhou: ____________________
