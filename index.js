const { ethers } = require("ethers");
const colors = require("colors");
const fs = require("fs");
const readlineSync = require("readline-sync");

const checkBalance = require("./src/checkBalance");
const displayHeader = require("./src/displayHeader");
const sleep = require("./src/sleep");
const { loadChains, selectChain, selectNetworkType } = require("./src/chainUtils");

const MAX_RETRIES = 5;
const RETRY_DELAY = 5000;

async function retry(fn, maxRetries = MAX_RETRIES, delay = RETRY_DELAY) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (i === maxRetries - 1) throw error;
            console.log(colors.yellow(`⚠️ Error occurred. Retrying... (${i + 1}/${maxRetries})`));
            await sleep(delay);
        }
    }
}

function readPrivateKeys() {
    if (!fs.existsSync("privateKeys.txt")) {
        console.log(colors.red("🚨 Error: privateKeys.txt file does not exist."));
        process.exit(1);
    }
    
    const privateKeys = fs.readFileSync("privateKeys.txt", "utf8")
        .split('\n')
        .map(key => key.trim())
        .filter(key => key.length > 0);
    
    if (privateKeys.length === 0) {
        console.log(colors.red("🚨 Error: No private keys found in privateKeys.txt."));
        process.exit(1);
    }
    
    return privateKeys;
}

function readTargetAddresses() {
    if (!fs.existsSync("targetaddress.txt")) {
        console.log(colors.red("🚨 Error: targetaddress.txt file does not exist."));
        process.exit(1);
    }
    
    const addresses = fs.readFileSync("targetaddress.txt", "utf8")
        .split('\n')
        .map(addr => addr.trim())
        .filter(addr => addr.length > 0);
    
    if (addresses.length === 0) {
        console.log(colors.red("🚨 Error: No target addresses found in targetaddress.txt."));
        process.exit(1);
    }
    
    return addresses;
}

function selectTransferType() {
    console.log("");
    console.log(colors.cyan("🔄 Select transfer type:"));
    const types = ["Native Token", "ERC20/BEP20 Token"];
    const selectedIndex = readlineSync.keyInSelect(types, "Which type of token do you want to transfer?");
    
    if (selectedIndex === -1) {
        console.log(colors.red("🚨 No transfer type selected. Exiting..."));
        process.exit(1);
    }
    
    return selectedIndex === 0 ? "native" : "token";
}

function selectTransferDirection() {
    console.log("");
    console.log(colors.cyan("🔄 Select transfer direction:"));
    const directions = ["One to Many (1 sender → many receivers)", "Many to One (many senders → 1 receiver)"];
    const selectedIndex = readlineSync.keyInSelect(directions, "Which transfer direction do you want?");
    
    if (selectedIndex === -1) {
        console.log(colors.red("🚨 No transfer direction selected. Exiting..."));
        process.exit(1);
    }
    
    return selectedIndex === 0 ? "one-to-many" : "many-to-one";
}

function getTransferAmount() {
    console.log("");
    const amount = readlineSync.question("Enter amount to transfer per transaction: ");
    return parseFloat(amount);
}

function getTokenContract() {
    console.log("");
    const tokenContract = readlineSync.question("Enter token contract address: ");
    if (!ethers.isAddress(tokenContract)) {
        console.log(colors.red("🚨 Invalid token contract address."));
        process.exit(1);
    }
    return tokenContract;
}

function getDestinationAddress() {
    console.log("");
    const destination = readlineSync.question("Enter destination address for all transfers: ");
    if (!ethers.isAddress(destination)) {
        console.log(colors.red("🚨 Invalid destination address."));
        process.exit(1);
    }
    return destination;
}

async function transferToken(tokenContract, fromWallet, toAddress, amount) {
    const ERC20_ABI = [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function decimals() view returns (uint8)"
    ];
    const contract = new ethers.Contract(tokenContract, ERC20_ABI, fromWallet);
    const decimals = await contract.decimals();
    const amountWithDecimals = ethers.parseUnits(amount.toString(), decimals);
    
    const tx = await contract.transfer(toAddress, amountWithDecimals);
    return tx;
}

const main = async () => {
    displayHeader();

    const networkType = selectNetworkType();
    const chains = loadChains(networkType);
    const selectedChain = selectChain(chains);

    console.log(colors.green(`✅ You have selected: ${selectedChain.name}`));
    console.log(colors.green(`🛠 RPC URL: ${selectedChain.rpcUrl}`));
    console.log(colors.green(`🔗 Chain ID: ${selectedChain.chainId}`));

    const provider = new ethers.JsonRpcProvider(selectedChain.rpcUrl);
    
    const transferType = selectTransferType();
    const transferDirection = selectTransferDirection();
    
    let tokenContract = null;
    let amount;
    
    if (transferType === "token") {
        tokenContract = getTokenContract();
    }
    
    amount = getTransferAmount();
    
    let destinationAddress = null;
    if (transferDirection === "many-to-one") {
        destinationAddress = getDestinationAddress();
    }
    
    const privateKeys = readPrivateKeys();
    const targetAddresses = readTargetAddresses();
    
    const transactionCount = readlineSync.questionInt(
        "Enter the number of transactions you want to send for each address: "
    );

    if (transferDirection === "one-to-many") {
        // One sender to many receivers
        for (const privateKey of privateKeys) {
            const wallet = new ethers.Wallet(privateKey, provider);
            const senderAddress = wallet.address;

            console.log(colors.cyan(`💼 Processing transactions for address: ${senderAddress}`));

            let senderBalance;
            try {
                senderBalance = await retry(() => checkBalance(provider, senderAddress, tokenContract));
            } catch (error) {
                console.log(
                    colors.red(`❌ Failed to check balance for ${senderAddress}. Skipping to next address.`)
                );
                continue;
            }

            const balanceFormatted = transferType === "native" 
                ? ethers.formatUnits(senderBalance, "ether")
                : ethers.formatUnits(senderBalance, 18); // Default to 18 decimals
            
            console.log(colors.blue(`💰 Current Balance: ${balanceFormatted} ${transferType === "native" ? selectedChain.symbol : "tokens"}`));

            if (parseFloat(balanceFormatted) < amount * transactionCount) {
                console.log(colors.red("❌ Insufficient balance for all transactions. Skipping to next address."));
                continue;
            }

            for (let i = 0; i < transactionCount; i++) {
                // Pick a random target address
                const receiverAddress = targetAddresses[Math.floor(Math.random() * targetAddresses.length)];
                console.log(colors.white(`\n🆕 Sending to address: ${receiverAddress}`));

                let tx;
                try {
                    if (transferType === "native") {
                        const amountToSend = ethers.parseUnits(amount.toString(), "ether");
                        
                        let gasPrice;
                        try {
                            gasPrice = (await provider.getFeeData()).gasPrice;
                        } catch (error) {
                            console.log(colors.red("❌ Failed to fetch gas price from the network."));
                            continue;
                        }

                        const transaction = {
                            to: receiverAddress,
                            value: amountToSend,
                            gasLimit: 21000,
                            gasPrice: gasPrice,
                            chainId: parseInt(selectedChain.chainId),
                        };

                        tx = await retry(() => wallet.sendTransaction(transaction));
                    } else {
                        tx = await retry(() => transferToken(tokenContract, wallet, receiverAddress, amount));
                    }
                } catch (error) {
                    console.log(colors.red(`❌ Failed to send transaction: ${error.message}`));
                    continue;
                }

                console.log(colors.white(`🔗 Transaction ${i + 1}:`));
                console.log(colors.white(`  Hash: ${colors.green(tx.hash)}`));
                console.log(colors.white(`  From: ${colors.green(senderAddress)}`));
                console.log(colors.white(`  To: ${colors.green(receiverAddress)}`));
                console.log(
                    colors.white(
                        `  Amount: ${colors.green(amount.toString())} ${
                            transferType === "native" ? selectedChain.symbol : "tokens"
                        }`
                    )
                );

                await sleep(15000);

                let receipt;
                try {
                    receipt = await retry(() => provider.getTransactionReceipt(tx.hash));
                    if (receipt) {
                        if (receipt.status === 1) {
                            console.log(colors.green("✅ Transaction Success!"));
                            console.log(colors.green(`  Block Number: ${receipt.blockNumber}`));
                            console.log(colors.green(`  Gas Used: ${receipt.gasUsed.toString()}`));
                            console.log(
                                colors.green(`  Transaction hash: ${selectedChain.explorer}/tx/${receipt.hash}`)
                            );
                        } else {
                            console.log(colors.red("❌ Transaction FAILED"));
                        }
                    } else {
                        console.log(colors.yellow("⏳ Transaction is still pending after multiple retries."));
                    }
                } catch (error) {
                    console.log(colors.red(`❌ Error checking transaction status: ${error.message}`));
                }

                console.log();
            }

            console.log(colors.green(`✅ Finished transactions for address: ${senderAddress}`));
        }
    } else {
        // Many senders to one receiver
        console.log(colors.cyan(`💼 All transactions will be sent to: ${destinationAddress}`));
        
        for (const privateKey of privateKeys) {
            const wallet = new ethers.Wallet(privateKey, provider);
            const senderAddress = wallet.address;

            console.log(colors.cyan(`💼 Processing transactions from address: ${senderAddress}`));

            let senderBalance;
            try {
                senderBalance = await retry(() => checkBalance(provider, senderAddress, tokenContract));
            } catch (error) {
                console.log(
                    colors.red(`❌ Failed to check balance for ${senderAddress}. Skipping to next address.`)
                );
                continue;
            }

            const balanceFormatted = transferType === "native" 
                ? ethers.formatUnits(senderBalance, "ether")
                : ethers.formatUnits(senderBalance, 18); // Default to 18 decimals
            
            console.log(colors.blue(`💰 Current Balance: ${balanceFormatted} ${transferType === "native" ? selectedChain.symbol : "tokens"}`));

            if (parseFloat(balanceFormatted) < amount) {
                console.log(colors.red("❌ Insufficient balance for transaction. Skipping to next address."));
                continue;
            }

            for (let i = 0; i < transactionCount; i++) {
                console.log(colors.white(`\n🆕 Sending transaction ${i + 1} from ${senderAddress}`));

                let tx;
                try {
                    if (transferType === "native") {
                        const amountToSend = ethers.parseUnits(amount.toString(), "ether");
                        
                        let gasPrice;
                        try {
                            gasPrice = (await provider.getFeeData()).gasPrice;
                        } catch (error) {
                            console.log(colors.red("❌ Failed to fetch gas price from the network."));
                            continue;
                        }

                        const transaction = {
                            to: destinationAddress,
                            value: amountToSend,
                            gasLimit: 21000,
                            gasPrice: gasPrice,
                            chainId: parseInt(selectedChain.chainId),
                        };

                        tx = await retry(() => wallet.sendTransaction(transaction));
                    } else {
                        tx = await retry(() => transferToken(tokenContract, wallet, destinationAddress, amount));
                    }
                } catch (error) {
                    console.log(colors.red(`❌ Failed to send transaction: ${error.message}`));
                    continue;
                }

                console.log(colors.white(`🔗 Transaction ${i + 1}:`));
                console.log(colors.white(`  Hash: ${colors.green(tx.hash)}`));
                console.log(colors.white(`  From: ${colors.green(senderAddress)}`));
                console.log(colors.white(`  To: ${colors.green(destinationAddress)}`));
                console.log(
                    colors.white(
                        `  Amount: ${colors.green(amount.toString())} ${
                            transferType === "native" ? selectedChain.symbol : "tokens"
                        }`
                    )
                );

                await sleep(15000);

                let receipt;
                try {
                    receipt = await retry(() => provider.getTransactionReceipt(tx.hash));
                    if (receipt) {
                        if (receipt.status === 1) {
                            console.log(colors.green("✅ Transaction Success!"));
                            console.log(colors.green(`  Block Number: ${receipt.blockNumber}`));
                            console.log(colors.green(`  Gas Used: ${receipt.gasUsed.toString()}`));
                            console.log(
                                colors.green(`  Transaction hash: ${selectedChain.explorer}/tx/${receipt.hash}`)
                            );
                        } else {
                            console.log(colors.red("❌ Transaction FAILED"));
                        }
                    } else {
                        console.log(colors.yellow("⏳ Transaction is still pending after multiple retries."));
                    }
                } catch (error) {
                    console.log(colors.red(`❌ Error checking transaction status: ${error.message}`));
                }

                console.log();
            }

            console.log(colors.green(`✅ Finished transactions for address: ${senderAddress}`));
        }
    }

    console.log("");
    console.log(colors.green("All transactions completed."));
    console.log(colors.green("Subscribe: https://t.me/HappyCuanAirdrop."));
    process.exit(0);
};

main().catch((error) => {
    console.error(colors.red("🚨 An unexpected error occurred:"), error);
    process.exit(1);
});
