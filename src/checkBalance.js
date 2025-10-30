const checkBalance = async (provider, address, tokenContract = null) => {
    if (tokenContract) {
        const { ethers } = require("ethers");
        const ERC20_ABI = [
            "function balanceOf(address owner) view returns (uint256)",
            "function decimals() view returns (uint8)"
        ];
        const contract = new ethers.Contract(tokenContract, ERC20_ABI, provider);
        const balance = await contract.balanceOf(address);
        return balance;
    } else {
        const balance = await provider.getBalance(address);
        return balance;
    }
};

module.exports = checkBalance;
