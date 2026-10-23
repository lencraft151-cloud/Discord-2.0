# Anleitung: Discord 2.0 hosten und mit deinem Discord-Konto einrichten

Diese Anleitung führt dich Schritt für Schritt durch alles:

1. **Discord-App anlegen.** Das ist dein Bot, einmalig, dauert ca. 10 Minuten.
2. **Discord 2.0 starten.** Entweder zum Ausprobieren auf deinem PC (2a) oder dauerhaft im Internet (2b).
3. **Auf deinem Discord-Konto einrichten.** Mit Discord anmelden, den Bot zu deinem Konto und zu deinen Servern hinzufügen.

Am Ende gibt es einen Abschnitt [Probleme & Lösungen](#probleme--lösungen).

> **Wichtig:** Token und Client Secret sind wie Passwörter. Gib sie nie weiter, poste sie nicht auf Discord und lade sie nicht auf GitHub hoch. Die Datei `.env` ist deshalb von Git ausgeschlossen. Falls doch mal etwas rauskommt: im Developer Portal auf **Reset** klicken und den neuen Wert eintragen.

---

## Teil 1: Discord-App anlegen

1. Öffne <https://discord.com/developers/applications> und melde dich mit deinem Discord-Konto an.
2. Klicke oben rechts auf **New Application**, gib einen Namen ein (z. B. „Discord 2.0“), hake die Bedingungen an und klicke auf **Create**.
   - Der Name darf das Wort „Discord“ nicht enthalten. Nimm dann z. B. „D2 Chat“.

### Bot einrichten (Menü links: „Bot“)

3. Klicke auf **Reset Token** → **Yes, do it!** und kopiere den Token. Du brauchst ihn gleich als `DISCORD_BOT_TOKEN`. Discord zeigt ihn nur einmal an. Wenn du ihn verlierst, einfach wieder auf Reset klicken.
4. Scrolle runter zu **Privileged Gateway Intents** und schalte diese beiden ein:
   - **Server Members Intent**
   - **Message Content Intent**

   Danach unten auf **Save Changes** klicken.
5. **Public Bot**:
   - **An** (Standard): Jeder mit „Server verwalten“ kann den Bot zu seinem Server hinzufügen, also auch deine Freunde.
   - **Aus**: Nur du kannst ihn hinzufügen. Setze dann unter „Installation“ den *Install Link* auf **None**, sonst meckert Discord beim Speichern.

### Installation (Menü links: „Installation“)

6. Hake bei **Installation Contexts** beide Felder an:
   - **User Install**: Damit kannst du den Bot zu deinem eigenen Konto hinzufügen.
   - **Guild Install**: Damit kannst du den Bot zu Servern hinzufügen.

   Dann **Save Changes**.

### Anmeldung mit Discord (Menü links: „OAuth2“)

7. Kopiere die **Client ID**. Das ist `DISCORD_CLIENT_ID`.
8. Klicke bei **Client Secret** auf **Reset Secret** und kopiere es. Das ist `DISCORD_CLIENT_SECRET`.
9. Klicke bei **Redirects** auf **Add Redirect** und trage die Adresse ein, unter der Discord 2.0 läuft, plus `/auth/discord/callback`:
   - zum Ausprobieren auf deinem PC: `http://localhost:3000/auth/discord/callback`
   - im Internet: `https://deine-domain.duckdns.org/auth/discord/callback`

   Du kannst auch beide eintragen. Dann **Save Changes**.

Fertig mit Discord. Du hast jetzt drei Werte: **Bot-Token**, **Client ID** und **Client Secret**.

---

## Teil 2a: Zum Ausprobieren auf deinem PC

Das ist der schnellste Weg. Discord 2.0 läuft dann nur, solange dein PC an ist, und nur du bzw. Leute in deinem WLAN können es öffnen. Zum Testen reicht das.

1. Installiere **Node.js** (Version „LTS“) von <https://nodejs.org>. Bei der Installation einfach immer auf „Weiter“ klicken.
2. Lade den Code herunter:
   - Auf GitHub im Repository auf den grünen Knopf **Code** → **Download ZIP** klicken und das ZIP entpacken.
   - Oder mit Git: `git clone https://github.com/lencraft151-cloud/Discord-2.0.git`

   > Solange der Pull Request noch nicht gemergt ist, liegt der Code im Branch `discord-bridge`. Wähle ihn auf GitHub oben links im Branch-Menü aus, bevor du das ZIP lädst, oder nimm `git clone -b discord-bridge …`.
3. Öffne im entpackten Ordner ein Terminal:
   - **Windows:** Im Explorer in die Adresszeile `cmd` tippen und Enter drücken.
   - **Mac:** Rechtsklick auf den Ordner → „Neues Terminal beim Ordner“.
4. Pakete installieren:
   ```
   npm install
   ```
5. Einstellungen anlegen:
   - Windows: `copy .env.example .env`
   - Mac/Linux: `cp .env.example .env`

   Öffne `.env` mit einem Texteditor (Windows: Rechtsklick → „Öffnen mit“ → Editor) und trag deine drei Werte aus Teil 1 ein:
   ```
   DISCORD_BOT_TOKEN=dein-bot-token
   DISCORD_CLIENT_ID=deine-client-id
   DISCORD_CLIENT_SECRET=dein-client-secret
   ```
6. Starten:
   ```
   npm start
   ```
   Wenn alles klappt, siehst du:
   ```
   Discord 2.0 läuft auf http://localhost:3000
   [discord] Verbunden als D2 Chat#1234 – 0 Server
   ```
7. Öffne <http://localhost:3000> im Browser und mach mit [Teil 3](#teil-3-auf-deinem-discord-konto-einrichten) weiter.

Zum Beenden drückst du im Terminal **Strg + C**.

---

## Teil 2b: Dauerhaft im Internet hosten

Damit Discord 2.0 rund um die Uhr läuft und deine Freunde es von überall öffnen können, brauchst du:

- **Einen kleinen Server (VPS)** mit Ubuntu 24.04, z. B. bei Hetzner, Netcup, IONOS oder Strato. Die kleinste Stufe reicht (1–2 CPU-Kerne, 2 GB RAM), das kostet etwa 4–6 € im Monat.
- **Eine Domain.** Kostenlos geht das z. B. mit [DuckDNS](https://www.duckdns.org): Dort mit Discord oder GitHub anmelden, eine Subdomain wie `meinchat.duckdns.org` anlegen und bei *current ip* die IP-Adresse deines Servers eintragen.
- **HTTPS.** Das ist Pflicht, sonst erlauben Browser kein Mikrofon und keine Kamera. Das macht im Folgenden **Caddy** automatisch.

Verbinde dich per SSH mit deinem Server. Unter Windows geht das im Terminal mit `ssh root@DEINE-SERVER-IP`. Dann alle Befehle der Reihe nach ausführen:

### 1. Programme installieren

```bash
# Node.js (LTS)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git caddy

# Firewall: nur SSH und Web zulassen
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

### 2. Discord 2.0 herunterladen

```bash
sudo git clone https://github.com/lencraft151-cloud/Discord-2.0.git /opt/discord-2.0

# Eigener Benutzer für den Dienst (sicherer als root)
sudo useradd --system --home-dir /opt/discord-2.0 --shell /usr/sbin/nologin discord2
sudo chown -R discord2:discord2 /opt/discord-2.0

cd /opt/discord-2.0
sudo -u discord2 npm install --omit=dev
```

> Solange der Pull Request nicht gemergt ist: Hänge beim `git clone` noch `-b discord-bridge` an.
> Falls dein Repository **privat** ist, fragt Git nach Benutzername und Passwort. Als Passwort brauchst du ein [GitHub-Token](https://github.com/settings/tokens) mit Leserechten. Alternativ machst du das Repository öffentlich, deine Geheimnisse stehen ja nur in der `.env`.

### 3. Einstellungen

```bash
sudo -u discord2 cp .env.example .env
sudo -u discord2 nano .env
```

Trage ein (Domain anpassen!):

```
PUBLIC_URL=https://meinchat.duckdns.org
DISCORD_BOT_TOKEN=dein-bot-token
DISCORD_CLIENT_ID=deine-client-id
DISCORD_CLIENT_SECRET=dein-client-secret
```

Speichern mit **Strg + O**, Enter, dann beenden mit **Strg + X**.

Danach noch zwei Dinge:

- Im Developer Portal unter **OAuth2 → Redirects** muss `https://meinchat.duckdns.org/auth/discord/callback` stehen (siehe Teil 1, Schritt 9).
- Damit niemand außer dem Dienst die Datei lesen kann:
  ```bash
  sudo chmod 600 .env
  ```

### 4. Als Dienst starten

Der Dienst startet automatisch beim Hochfahren und nach Abstürzen.

```bash
sudo cp deploy/discord2.service /etc/systemd/system/discord2.service
sudo systemctl daemon-reload
sudo systemctl enable --now discord2
sudo systemctl status discord2      # sollte "active (running)" zeigen
journalctl -u discord2 -f           # Live-Log ansehen (Strg + C zum Beenden)
```

Im Log sollte `[discord] Verbunden als …` stehen.

### 5. HTTPS mit Caddy

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile      # "deine-domain.duckdns.org" durch deine Domain ersetzen
sudo systemctl reload caddy
```

Caddy holt sich jetzt automatisch ein HTTPS-Zertifikat. Öffne `https://meinchat.duckdns.org`. Du solltest die Anmeldeseite mit dem Knopf **„Mit Discord anmelden“** sehen.

### Updates einspielen

```bash
cd /opt/discord-2.0
sudo -u discord2 git pull
sudo -u discord2 npm install --omit=dev
sudo systemctl restart discord2
```

Deine Daten (Konten, Nachrichten) liegen in `/opt/discord-2.0/data/` und bleiben bei Updates erhalten. Für ein Backup kopierst du diesen Ordner.

---

## Teil 3: Auf deinem Discord-Konto einrichten

### 1. Mit Discord anmelden

Öffne Discord 2.0 im Browser (`http://localhost:3000` oder deine Domain) und klicke auf **„Mit Discord anmelden“**. Discord fragt, ob die App deinen Namen und deine Serverliste sehen darf. Klicke auf **Autorisieren**.

- Damit legst du automatisch ein Konto mit deinem Discord-Namen und -Avatar an.
- Discord 2.0 sieht dabei nur, wer du bist und auf welchen Servern du bist. Es schreibt nie mit deinem Konto.
- Du hast schon ein normales Konto? Dann melde dich normal an, klicke auf den Kompass und dort auf **„Discord verbinden“**.

### 2. Bot zu deinem eigenen Konto hinzufügen

1. Klicke in Discord 2.0 links auf den **Kompass** („Entdecken“).
2. Klicke unten im Kasten „Bot hinzufügen“ auf **„Zu deinem eigenen Discord-Konto hinzufügen“**.
3. Discord fragt „Zu meinen Apps hinzufügen?“. Klicke auf **Autorisieren**.

Jetzt kannst du in Discord **überall** `/discord2` eintippen: auf jedem Server, in DMs und in Gruppen. Du bekommst dann (nur für dich sichtbar) den Link zu Discord 2.0. Ist der Bot auf dem Server noch nicht dabei, steht da auch gleich der Link zum Hinzufügen.

### 3. Bot zu deinen Servern hinzufügen

1. Klicke wieder auf den **Kompass**. Unter **„Deine Discord-Server“** stehen alle deine Server.
2. Bei jedem Server, auf dem du „Server verwalten“ darfst, steht **„Bot hinzufügen“**. Klick drauf und dann in Discord auf **Autorisieren**.
3. Zurück in Discord 2.0 den Kompass neu öffnen. Beim Server steht jetzt **„Beitreten“**, und schon bist du drin.

Auf Servern, auf denen du keine Admin-Rechte hast, muss ein Admin den Bot hinzufügen. Schick ihm einfach den Link „Zu einem Discord-Server hinzufügen“ aus dem Kompass-Fenster.

### 4. Ausprobieren

- **Schreiben:** Öffne einen Textkanal und schreib etwas. Auf Discord erscheint die Nachricht mit deinem Namen, deinem Avatar und „(D2)“.
- **Sprachkanal:** Klick auf einen 🔊-Kanal und erlaube das Mikrofon. Der Bot betritt den Sprachkanal auf Discord. Was du sagst, hören die Leute auf Discord, und du hörst sie.
- **Kamera / Bildschirm:** Unten links im Sprachfeld auf 📷 oder 🖥 klicken. Das sehen andere Nutzer von Discord 2.0; Discord-Nutzer sehen kein Video, weil Bots keins senden können.
- **Direktnachricht an Discord-Nutzer:** Klick in der Mitgliederliste rechts auf eine Person unter „Auf Discord“. Sie bekommt deine Nachricht vom Bot und kann direkt antworten.
- **Freunde anrufen:** Freunde, die auch Discord 2.0 benutzen, kannst du in der DM über 📞 anrufen.

---

## Probleme & Lösungen

| Problem | Lösung |
| --- | --- |
| Im Log steht `Used disallowed intents` | Im Developer Portal unter **Bot** die beiden Intents aus Teil 1, Schritt 4 einschalten und speichern. Dann neu starten. |
| Im Log steht `An invalid token was provided` | Der Bot-Token in `.env` ist falsch oder alt. Im Portal neu erstellen (Reset Token) und eintragen. |
| Kein Knopf „Mit Discord anmelden“ | `DISCORD_CLIENT_ID` oder `DISCORD_CLIENT_SECRET` fehlt in `.env`. Danach neu starten. |
| Discord sagt `Invalid OAuth2 redirect_uri` | Die Redirect-Adresse im Portal (OAuth2 → Redirects) muss **genau** `PUBLIC_URL` + `/auth/discord/callback` sein, inklusive `http`/`https`, ohne `/` am Ende von `PUBLIC_URL`. |
| „Kein Zugriff aufs Mikrofon“ | Im Internet nur mit **https://** öffnen. Außerdem im Browser neben der Adressleiste auf das Schloss klicken und Mikrofon/Kamera erlauben. |
| Anruf verbindet nicht (man hört sich nicht) | In manchen Netzen (Firma, Schule, Mobilfunk) gehen direkte Verbindungen nicht. Dann brauchst du einen TURN-Server, siehe `ICE_SERVERS` in `.env.example`. |
| Server taucht nicht unter „Entdecken“ auf | Ist der Bot wirklich auf dem Server? Darf er die Kanäle sehen? Prüfe auf Discord unter *Servereinstellungen → Rollen* die Rolle des Bots. |
| Bot kommt nicht in den Sprachkanal | Der Bot braucht dort „Verbinden“ und „Sprechen“. Außerdem kann er pro Server nur in **einem** Sprachkanal gleichzeitig sein. |
| `/discord2` erscheint nicht | Nach dem Hinzufügen kann es ein paar Minuten dauern. Discord neu laden (Strg + R). Prüfe auch, ob unter **Installation** „User Install“ angehakt ist. |
| „Private application cannot have a default authorization link“ | Du hast „Public Bot“ ausgeschaltet. Unter **Installation** den *Install Link* auf **None** stellen. |
| Seite nicht erreichbar (Teil 2b) | Zeigt die Domain auf die richtige IP (DuckDNS)? Läuft der Dienst (`sudo systemctl status discord2`)? Sind die Ports 80/443 offen (`sudo ufw status`)? |

Weitere technische Details stehen in der [README](README.md).
