# SYNTHETIC Offline-Simulation

Das ist Spielgeld im Prozess. Es ist kein Backtest, kein Live-Handel und keine Gewinnaussage. Die vorhandenen Bots werden nicht gestartet. Es gibt kein Netzwerk, keine Schlüssel und keine `.env`.

`OriginalBehaviorModel` skizziert nur gelesene Sniper-Defaults: Kauf 0,1 SOL, Stop-Faktor 0,5, Gewinnfaktor 2,0, höchstens 3 Positionen, Positionen nur im Speicher, bei markierter Migration wird die Position fallengelassen. Das JavaScript wird nicht ausgeführt. Ganzzahl-Mathematik der Chain wird nicht nachgebaut.

`ProposedBook` ist ein anderer Regelsatz zum Testen:

- 20 USD = 0,20 SOL bei **angenommenen** 100 USD je SOL. Das ist kein Marktkurs.
- Stop, wenn der synthetische Spot das 0,95-Fache des Einstiegsspots erreicht.
- Gewinnmitnahme, wenn der synthetische Spot das 1,10-Fache erreicht. Feste Testregel, keine optimierte Strategie.
- Vor dem Kauf müssen Einsatz, Kaufgebühren und eine Rücklage für die Verkaufsgebühren in die 0,20 SOL passen.
- Ein Fehlverkauf schreibt keinen Erlös gut. Eine Migration bleibt als `stuck_migrated` in der Kasse reserviert.
- Die Kasse kann als JSON mit dem Label `SYNTHETIC` gespeichert und wieder geladen werden.

Gebührenannahmen, solange nichts übergeben wird: Priorität 0,00012 SOL, Tip 0,0001 SOL, Basis 0,000005 SOL, Protokoll 1 Prozent. Slippage 500 Basispunkte ist ein adverses Szenario, keine gemessene Ausführung. 1,25 Prozent Protokoll ist eine zweite Annahme für ein adverses Szenario.

```bash
python3 simulation/test_harness.py -v
python3 simulation/harness.py
```

Beide Befehle brauchen nur die Python-Standardbibliothek. Abhängigkeiten des Repos nicht installieren.
