# Klownan

A command-line interface for procuring provisions from a large Icelandic establishment whose name we are not at liberty to disclose.

## What is this

Klownan facilitates the orderly acquisition of sustenance. It knows about categories. It knows about sandwiches. It can find yogurt when others cannot.

Authentication is handled via the national electronic identity apparatus. You will be asked to confirm things on your telephone. This is normal and expected.

## Installation

```bash
bun install
```

## Usage

```bash
klownan login <kennitala>     # summon the authentication ritual
klownan search <query>        # locate provisions
klownan add <sku> [qty]       # place provisions in the receptacle
klownan cart                  # inspect the receptacle
klownan use <group>           # select which household receives the provisions
klownan groups                # see who you are affiliated with
klownan orders                # reflect on past acquisitions
```

## Authentication

The system will present you with a four-digit code. You must select this code on your device. If you select the wrong code, nothing happens. If you select the correct code, you are granted provisions access for approximately thirty days.

The token refreshes itself. You do not need to think about this.

## Groups

Provisions can be directed toward different households. Each household maintains its own receptacle. Use `klownan use` to indicate which household is currently in need of provisions.

## Store context

Product availability varies by location. The system is aware of which location handles your provisions. Items that appear to exist may not exist at your location. This is the nature of provisions.

## Environment

You generally do not need these.

```
KRONAN_TOKEN    manual override (not recommended)
KRONAN_GROUP    manual group override
```

## License

ISC
