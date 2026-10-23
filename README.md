# Discord 2.0

Ein selbst gehosteter Chat im Stil von Discord, mit Servern, Text- und Sprachkanälen, Direktnachrichten, **Sprach- und Videoanrufen** und Bildschirm teilen. Dazu kommt eine **Brücke zum echten Discord**:

- **Mit Discord anmelden:** Melde dich mit deinem Discord-Konto an. Dann siehst du unter „Entdecken“ alle deine Discord-Server und fügst den Bot mit einem Klick hinzu, überall dort, wo du „Server verwalten“ darfst.
- **Bot fürs eigene Konto:** Du kannst den Bot auch nur deinem eigenen Discord-Konto hinzufügen („User Install“). Dann funktioniert `/discord2` überall auf Discord und bringt dich zur Website.
- **Echten Discord-Servern beitreten:** Discord-Server mit dem Bot tauchen unter „Entdecken“ (Kompass-Symbol) auf. Dort siehst du Kanäle und Verlauf und schreibst live mit.
- **In Discord-Sprachkanälen mitreden:** Wenn du in Discord 2.0 einem Sprachkanal eines Discord-Servers beitrittst, kommt der Bot in den Kanal. Er spielt dein Mikrofon auf Discord ab und schickt dir, was die Leute dort sagen.
- **Mit Discord-Nutzern chatten:** In gespiegelten Kanälen erscheinen deine Nachrichten auf Discord unter deinem Namen (mit Discord-Anmeldung auch mit deinem Avatar) und dem Zusatz „(D2)“. Außerdem kannst du Discord-Nutzern **Direktnachrichten** schicken: Sie bekommen sie vom Bot und können direkt darauf antworten.

## Warum ein Bot und kein normaler Discord-Login?

Discord verbietet in seinen Nutzungsbedingungen inoffizielle Clients und automatisierte normale Nutzerkonten („Self-Bots“), und Konten, die so etwas tun, werden gesperrt. Darum läuft die Verbindung über einen **offiziellen Discord-Bot**, so wie bei den bekannten Matrix-Discord-Brücken. Daraus folgt:

- Ein Discord-Server erscheint erst, wenn jemand mit der Berechtigung „Server verwalten“ den Bot dort einlädt. Das ist gleichzeitig die Zustimmung des Servers, gespiegelt zu werden. Fügst du den Bot nur deinem Konto hinzu, kann er auf fremden Servern nichts mitlesen. Discord erlaubt das bei „User Install“ nicht, dort gibt es nur `/discord2`.
- „Mit Discord anmelden“ bestätigt nur, wer du bist und auf welchen Servern du bist. Discord 2.0 schreibt nie mit deinem Konto.
- Auf Discord sind Nachrichten und Stimme aus Discord 2.0 als Bot bzw. Webhook gekennzeichnet. Den grünen Rahmen beim Sprechen bekommt der Bot.
- Direktnachrichten an Discord-Nutzer funktionieren nur, wenn der Nutzer mindestens einen Server mit dem Bot teilt und Direktnachrichten von Servermitgliedern erlaubt. Telefonieren mit einzelnen Discord-Nutzern geht nicht, weil Bots niemanden anrufen können. Nutzt dafür einen Sprachkanal.
- Ein Bot kann pro Discord-Server nur in **einem** Sprachkanal gleichzeitig sein.

## Starten

> **Neu hier?** Die [Schritt-für-Schritt-Anleitung](ANLEITUNG.md) erklärt alles: Discord-App anlegen, auf dem PC oder einem Server hosten und den Bot auf deinem Discord-Konto und deinen Servern einrichten.
>
> **Automatisch hosten:** Mit `.github/workflows/deploy.yml` spielt GitHub Actions jeden Push auf `main` als Docker-Container mit HTTPS auf deinen Server auf. Du musst nur ein paar Secrets eintragen ([Anleitung, Teil 2b](ANLEITUNG.md#teil-2b-automatisch-über-github-actions-empfohlen)).

Du brauchst **Node.js 22.13 oder neuer** (die Datenbank nutzt das eingebaute `node:sqlite`).

```bash
npm install
cp .env.example .env   # optional, siehe unten
npm start
```

Dann <http://localhost:3000> öffnen, ein Konto registrieren und loslegen. Ohne Bot-Token läuft alles außer der Discord-Brücke.

## Discord-Bot einrichten

1. Im [Discord Developer Portal](https://discord.com/developers/applications) eine **New Application** anlegen.
2. Unter **Bot**:
   - **Reset Token** klicken und den Token als `DISCORD_BOT_TOKEN` in `.env` eintragen.
   - Unter *Privileged Gateway Intents* **Server Members Intent** und **Message Content Intent** einschalten.
3. Unter **Installation** bei *Installation Contexts* **Guild Install** und **User Install** anhaken. Dann kann jeder den Bot auch nur seinem eigenen Konto hinzufügen.
4. Unter **OAuth2** (für „Mit Discord anmelden“):
   - *Client ID* als `DISCORD_CLIENT_ID` und *Client Secret* als `DISCORD_CLIENT_SECRET` eintragen.
   - Bei *Redirects* die Adresse `<PUBLIC_URL>/auth/discord/callback` hinzufügen, lokal also `http://localhost:3000/auth/discord/callback`.
5. Discord 2.0 neu starten. In der Konsole steht dann `[discord] Verbunden als …`.
6. In Discord 2.0 auf den Kompass klicken. Dort stehen die Links, um den Bot zu einem Server oder zum eigenen Konto hinzuzufügen. Mit Discord-Anmeldung gibt es dort außerdem „Deine Discord-Server“ mit einem Knopf „Bot hinzufügen“ pro Server.

Der Bot fragt diese Rechte an: Kanäle ansehen, Nachrichten senden, Nachrichtenverlauf lesen, Webhooks verwalten, Links einbetten, Dateien anhängen, Sprachkanälen beitreten und sprechen. Er spiegelt alle Text-, Ankündigungs- und Sprachkanäle, die er sehen darf. Über die Kanalrechte des Bots auf Discord legst du fest, welche Kanäle sichtbar sind. „Webhooks verwalten“ sorgt dafür, dass Nachrichten aus Discord 2.0 mit dem Namen des Absenders erscheinen. Fehlt das Recht, schreibt der Bot selbst und setzt den Namen vor die Nachricht.

### Anrufe

Zwischen Nutzern von Discord 2.0 laufen Anrufe direkt von Browser zu Browser (WebRTC), auch mit Kamera und Bildschirm teilen. Der Server vermittelt nur die Verbindung. Ein paar Dinge sind dabei wichtig:

- Browser geben Mikrofon und Kamera nur über **HTTPS** oder auf `localhost` frei. Für den Einsatz im Internet brauchst du also HTTPS, z. B. über einen Reverse-Proxy wie Caddy oder nginx.
- In manchen Netzen klappen direkte Verbindungen nicht. Trag dann unter `ICE_SERVERS` einen TURN-Server ein (z. B. [coturn](https://github.com/coturn/coturn)).
- Jeder schickt sein Bild an jeden anderen. Das ist für kleine Runden mit bis zu etwa 6 Leuten gedacht.
- In Discord-Sprachkanälen läuft das Audio über den Server zum Bot. Kamera und Bildschirm sehen dort nur andere Discord-2.0-Nutzer, weil Bots auf Discord kein Video senden können.

### Konfiguration (`.env`)

| Variable              | Bedeutung                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `PORT`                | Port des Webservers (Standard `3000`)                                                      |
| `PUBLIC_URL`          | Öffentliche Adresse, z. B. `https://chat.example.com` (Standard `http://localhost:PORT`)  |
| `DATABASE_FILE`       | Pfad der SQLite-Datenbank (Standard `data/discord2.db`)                                    |
| `DISCORD_BOT_TOKEN`   | Token des Brücken-Bots. Leer bedeutet: keine Brücke                                        |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Für „Mit Discord anmelden“. Leer bedeutet: nur normale Konten       |
| `AVATAR_URL_TEMPLATE` | Optionale Bild-URL für Discord-2.0-Nutzer ohne Discord-Konto, mit `{username}` und `{id}` als Platzhalter |
| `ICE_SERVERS`         | Optionale STUN/TURN-Server für Anrufe als JSON (Standard: öffentlicher Google-STUN)        |

## Funktionen

- Registrierung und Anmeldung (Passwörter mit scrypt gehasht) oder „Mit Discord anmelden“. Ein bestehendes Konto lässt sich nachträglich mit Discord verbinden
- Eigene Server erstellen, Text- und Sprachkanäle anlegen, Freunde per Einladungscode einladen
- Echtzeit-Chat über Socket.IO mit „… schreibt“-Anzeige, Ungelesen-Markierungen und Online-Status
- Direktnachrichten zwischen Discord-2.0-Nutzern, mit Anruf (es klingelt beim anderen)
- Sprachkanäle und Anrufe: stummschalten, Ton aus, Kamera, Bildschirm teilen und eine Sprechanzeige. In der Seitenleiste siehst du, wer gerade in welchem Kanal ist
- Discord-Brücke:
  - Eigene Discord-Server sehen und den Bot dort mit einem Klick hinzufügen (mit Discord-Anmeldung)
  - Bot für das eigene Konto („User Install“) mit dem Befehl `/discord2`
  - Discord-Server entdecken und beitreten, Kanäle werden automatisch abgeglichen
  - Discord-Sprachkanäle: Der Bot tritt bei, Audio läuft in beide Richtungen, und du siehst, wer auf Discord im Kanal ist
  - Nachrichten in beide Richtungen, inklusive Bearbeiten und Löschen auf Discord-Seite
  - Beim ersten Öffnen eines Discord-Kanals werden die letzten 50 Nachrichten geladen
  - Mitgliederliste zeigt Discord-Mitglieder an. Ein Klick darauf startet eine Direktnachricht
  - Nutzersuche über Discord 2.0 und alle verbundenen Discord-Server (auch per Discord-Nutzer-ID)
  - Discord-Anhänge erscheinen als Links bzw. Bilder
  - Aus Discord 2.0 heraus gehen keine `@everyone`- oder Rollen-Pings raus

## Projektaufbau

```
server/
  index.js           Startpunkt (liest .env)
  app.js             Express + Socket.IO zusammenstecken
  db.js              SQLite-Schema
  store.js           Datenzugriff (Nutzer, Server, Kanäle, Nachrichten)
  chat.js            Nachrichten senden/verteilen, Bindeglied zur Brücke
  api.js             REST-API unter /api
  realtime.js        Socket.IO-Ereignisse
  voice.js           Anrufräume, WebRTC-Vermittlung, Audio zum Bot
  audio.js           Audio umrechnen und mischen (Browser ⇄ Discord)
  discord-bridge.js  Discord-Bot (discord.js)
  discord-voice.js   Sprachverbindung des Bots (@discordjs/voice)
  discord-oauth.js   „Mit Discord anmelden“
deploy/              Server-Dateien: docker-compose.yml + Caddyfile (Docker), discord2.service (ohne Docker)
.github/workflows/   ci.yml (Tests), deploy.yml (Container bauen und auf den Server ausliefern)
Dockerfile           Container-Image
public/              Weboberfläche (HTML/CSS/JS ohne Build-Schritt)
  voice.js           Anrufe im Browser (WebRTC)
  voice-worklets.js  Mikrofon aufnehmen / Discord-Audio abspielen
test/                Tests (npm test)
```

## Tests

```bash
npm test
```
