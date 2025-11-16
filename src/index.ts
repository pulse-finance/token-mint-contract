import dotenv from "dotenv";
import { bytesToHex, encodeUtf8, hexToBytes } from "@helios-lang/codec-utils"
import { Program } from "@helios-lang/compiler"
import { makeAssetClass, makeInlineTxOutputDatum, makeMintingPolicyHash, makeValue, parseShelleyAddress } from "@helios-lang/ledger"
import { makeBlockfrostV0Client, makeSimpleWallet, makeTxBuilder, restoreRootPrivateKey } from "@helios-lang/tx-utils"
import { makeByteArrayData, makeConstrData, makeIntData, makeListData, makeMapData } from "@helios-lang/uplc"

dotenv.config()

const supply = 20_000_000_000_000n // 6 decimals
const multisigAddress = parseShelleyAddress("addr1xy5u66zysgwq3tu8qmynude57rww06tukq2tqjgv4rve6hewqrearru3df9uh68a0pfudzkes0t2r3zf6trszrt3jrpqgrdan5")
const walletPhrase = process.env.WALLET_PHRASE
const blockfrostKey = process.env.BLOCKFROST_KEY


const src = `
minting pulse_token_policy

import Cip67
import { get_current_minting_policy_hash, tx } from ScriptContext

const name = "PULSE"
const token_name_suffix = name.encode_utf8()
const seed: TxOutputId = TxOutputId::new(TxId::new(#6be04e38a692c28eb54c96b2f2187d03ff15fcf8dcee8b35c8a141d4cd61799e), 0)
const supply = 20_000_000_000_000
const decimals = 6
const mph = get_current_minting_policy_hash()
const asset_class = AssetClass::new(mph, Cip67::fungible_token_label + token_name_suffix)
const metadata_nft = AssetClass::new(mph, Cip67::reference_token_label + token_name_suffix)

// the destination address is the multisig address
const destination = Address::from_bytes(#3129cd6844821c08af8706c93e3734f0dce7e97cb014b0490ca8d99d5f2e00f3d18f916a4bcbe8fd7853c68ad983d6a1c449d2c7010d7190c2)

struct MetadataContent {
    name: String "name"
    description: String "description"
    decimals: Int "decimals"
    ticker: String "ticker"
    url: String "url"
    logo: String "logo"
}

enum Cip68Extra {
    Unused
}

enum Metadata {
    Cip68 {
        metadata: MetadataContent
        version: Int
        extra: Cip68Extra
    }
}

func main(_) -> () {
    assert(
        tx.inputs.any((input: TxInput) -> {
            input.output_id == seed
        }),
        "seed UTxO not spent"
    )

    assert(
        tx.minted == Value::new(asset_class, supply) + Value::new(metadata_nft, 1),
        "unexpected assets minted"
    )

    assert(
        tx.outputs.any((output: TxOutput) -> {
            output.address == destination &&
            output.value >= Value::new(asset_class, supply)
        }),
        "no output found that sends whole supply to multisig"
    )

    metadata_output = tx.outputs.find((output: TxOutput) -> {
        output.address == destination &&
        output.value >= Value::new(metadata_nft, 1)
    })

    metadata_datum = metadata_output.datum.inline.as[Metadata]

    assert(
        metadata_datum == Metadata::Cip68{
            MetadataContent{
                name: name,
                description: "PULSE Token",
                decimals: decimals,
                ticker: name,
                url: "https://pulsecardano.org",
                logo: "https://pulsecardano.org/logo"
            },
            1,
            Cip68Extra::Unused
        },
        "unexpected metadata"
    )
}
`

async function main() {
    if (!walletPhrase) {
        throw new Error("WALLET_PHRASE not set (hint: create .env file like the .env.example")
    }

    if (!blockfrostKey) {
        throw new Error("BLOCKFROST_KEY not set (hint: create .env file like the .env.example")
    }

    const program = new Program(src, {isTestnet: false})

    const uplc = program.compile({optimize: false})

    const mph = makeMintingPolicyHash(uplc.hash())

    console.log("Policy: ", mph.toHex())
    
    const ticker = "PULSE"
    const tokenName = hexToBytes("0014df10").concat(encodeUtf8(ticker))
    const assetClass = makeAssetClass(mph, tokenName)
    const metadataTokenName = hexToBytes("000643b0").concat(encodeUtf8(ticker))
    const metadataAssetClass = makeAssetClass(mph, metadataTokenName)

    const cardanoClient = makeBlockfrostV0Client("mainnet", blockfrostKey)
    const wallet = makeSimpleWallet(restoreRootPrivateKey(walletPhrase.split(" ")), cardanoClient)
    console.log("Wallet address: ", wallet.address.toBech32())
    const utxos = await wallet.utxos
    console.log("Wallet UTxOs:")
    for (let utxo of utxos) {
        console.log(utxo.dump())
    }

    const metadataDatum = makeConstrData(0, [
        makeMapData([
            [makeByteArrayData(encodeUtf8("name")), makeByteArrayData(encodeUtf8(ticker))],
            [makeByteArrayData(encodeUtf8("description")), makeByteArrayData(encodeUtf8("PULSE Token"))],
            [makeByteArrayData(encodeUtf8("decimals")), makeIntData(6)],
            [makeByteArrayData(encodeUtf8("ticker")), makeByteArrayData(encodeUtf8(ticker))],
            [makeByteArrayData(encodeUtf8("url")), makeByteArrayData(encodeUtf8("https://pulsecardano.org"))],
            [makeByteArrayData(encodeUtf8("logo")), makeByteArrayData(encodeUtf8("https://pulsecardano.org/logo"))],
        ]),
        makeIntData(1n),
        makeConstrData(0, [])
    ])
    

    const b = makeTxBuilder({isMainnet: true})

    b.attachUplcProgram(uplc)
    b.mintPolicyTokensUnsafe(mph, [[tokenName, supply], [metadataTokenName, 1]], makeIntData(0))
    b.payUnsafe(multisigAddress, makeValue(0n, [[assetClass, supply]]), makeInlineTxOutputDatum(makeIntData(0n)))
    b.payUnsafe(multisigAddress, makeValue(0n, [[metadataAssetClass, 1]]), makeInlineTxOutputDatum(metadataDatum))

    const tx = await b.build({
        networkParams: cardanoClient.parameters,
        spareUtxos: utxos,
        changeAddress: wallet.address,
    })

    tx.addSignatures(await wallet.signTx(tx))

    cardanoClient.submitTx(tx)
}

main()