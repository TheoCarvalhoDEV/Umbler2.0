# Aceite manual: ações de mensagem

Roteiro do §11 da [especificação](../specs/2026-10-16-acoes-mensagem-design.md). Rode no ambiente local, com o número de teste e um segundo celular fazendo o papel do cliente.

> ⚠️ Use só o **número de teste**. Se você ler o QR com o número do escritório, ele sai do Umbler Talk na hora.

## 0. Antes de começar

- [ ] Testes automáticos passando:

```bash
npm test
npm run typecheck
```

- [ ] O ambiente local está rodando (`npm run dev:up` e `npm run dev`), e o canal do número de teste aparece como **Conectado**.
- [ ] No log do app, logo depois de subir, **não** aparece `webhook sync failed`.
- [ ] A instância recebe os eventos novos. Troque `<instância>` pelo nome em Configurações › Canais (`talk-…`) e rode:

```bash
curl -s -H "apikey: $EVOLUTION_API_KEY" http://127.0.0.1:8081/webhook/find/<instância>
```

  O campo `events` precisa ter `MESSAGES_DELETE` e **não** pode ter `MESSAGES_EDITED`.
- [ ] Existe uma conversa aberta com o celular do "cliente", atribuída a você.
- [ ] Anote a versão testada: `git log -1 --format=%h` → `________`

## A. Reagir

- [ ] Passe o mouse numa mensagem do cliente, clique em **Ações da mensagem** › **Reagir** › 👍. A reação aparece abaixo da bolha e no celular do cliente.
- [ ] Reaja com ❤️: troca no celular. Reaja ❤️ de novo: a reação some.
- [ ] Em **Reagir**, clique no campo **Outro emoji**, abra os emojis do Windows (`Win + .`), escolha um e tecle Enter.
- [ ] O cliente reage a uma mensagem nossa e nós reagimos à mesma: as duas reações aparecem lado a lado.
- [ ] Reaja pelo **celular do escritório**: no sistema ela aparece como reação do escritório, sem apagar a do cliente.

## B. Apagar para todos

- [ ] Envie "teste apagar". Em **Ações da mensagem** › **Apagar para todos**, a pergunta "Apagar para todos?" aparece com "O contato deixa de ver esta mensagem.". Confirme.
- [ ] A mensagem some no celular do cliente. No sistema o texto continua, com a tag **Apagada por <seu nome>**, e a linha do tempo mostra "Mensagem apagada por <seu nome>".
- [ ] Mensagem do cliente: o menu não tem **Editar** nem **Apagar para todos**.
- [ ] Numa mensagem nossa com mais de 48 h, **Apagar para todos** aparece desabilitado com "Só até 48 h após o envio".
- [ ] Apague uma mensagem pelo **celular do escritório**: no sistema aparece a tag **Apagada pelo celular**.

## C. Editar

- [ ] Envie "reunião às 14h". Em **Editar**, troque por "reunião às 15h" e tecle Enter. Muda no celular do cliente (com "Editada"), e no sistema aparece a tag **editada**.
- [ ] Clique em **editada**: "Versões anteriores" mostra "reunião às 14h" com data e hora.
- [ ] Comece outra edição e tecle Esc: nada muda.
- [ ] Depois de 15 min, **Editar** fica desabilitado com "Só até 15 min após o envio".

## D. O contato apaga e edita

- [ ] O cliente apaga uma mensagem para todos. No sistema o texto **continua visível**, com a tag **Apagada pelo contato**.
- [ ] O cliente edita uma mensagem. Aparece o texto novo com a tag **editada pelo contato**, e clicar nela mostra o texto anterior.
- [ ] Se o WhatsApp do cliente usar o formato novo de edição, a tag é **editada pelo contato (novo texto indisponível)**. O texto anterior continua, e **não** surge uma bolha "Mensagem não suportada".
- Qual dos dois apareceu? `________`

## E. Figurinhas

- [ ] Peça ao cliente para mandar uma figurinha. No compositor, **Figurinhas** mostra ela em "Figurinhas recentes". Clique nela: a figurinha chega no celular do cliente.
- [ ] Mande a mesma figurinha duas vezes: a lista não a repete.
- [ ] **Enviar imagem como figurinha** com um PNG pequeno: chega como figurinha.
- [ ] Um arquivo de mais de 1 MB mostra "Envie uma imagem PNG, JPEG ou WebP de até 1 MB".

## F. Encaminhar

- [ ] Numa foto do cliente, use **Encaminhar** e, em **Conversa ou contato**, digite o nome de outra conversa aberta e clique nela. A foto chega no outro celular, e a bolha nova tem a tag **Encaminhada**. No celular não aparece a marca "Encaminhada" do WhatsApp: é uma limitação da Evolution 2.3.7.
- [ ] Encaminhe para um contato **sem** conversa aberta: abre uma conversa nova, atribuída a você.
- [ ] Encaminhe uma mídia que mostra "mídia indisponível": aparece "Esta mídia não está disponível para encaminhar".

## Pontos para anotar

- Número com o 9º dígito (DDD 31 ou maior): apagar, reagir e editar funcionaram? `________`
- Contato só com LID (sem telefone): apagar e editar funcionaram? `________`
- Se a Evolution recusar uma edição ("Não foi possível editar no WhatsApp"), confira se `DATABASE_SAVE_DATA_NEW_MESSAGE` está `"true"`: a edição exige a mensagem original no banco da Evolution.
