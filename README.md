# Comunicados Alunos

Central separada para envio controlado de comunicados a alunos via WhatsApp.

## Recursos
- Importação de `.xlsx`, `.xls` e `.csv`
- Identificação automática da coluna de telefone
- Normalização de números brasileiros
- Remoção de duplicados e inválidos
- Fila de envio em lotes configuráveis
- Padrão: 5 mensagens a cada 10 minutos
- Pausar, continuar e cancelar
- Progresso em tempo real
- Histórico de enviados, falhas e pendentes
- Modo de teste ativado por padrão
- Integração preparada para WhatsApp Cloud API oficial

> Use apenas com contatos que autorizaram comunicações da instituição. O controle de lotes organiza a operação e não deve ser usado para contornar mecanismos anti-spam.

## Rodando localmente

```bash
npm install
cp .env.example .env
npm start
```

Abra `http://localhost:3000`.

## WhatsApp

Por segurança, o projeto inicia em `DRY_RUN=true`, simulando os envios sem mandar mensagens reais.

Para integrar a WhatsApp Cloud API, configure as variáveis do `.env`. Mensagens iniciadas pela instituição fora da janela de atendimento podem exigir template aprovado pela Meta.
