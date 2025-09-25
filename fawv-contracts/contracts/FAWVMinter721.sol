// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract FAWVMinter721 is ERC721URIStorage, Ownable {
    uint256 private _nextId = 1;
    mapping(uint256 => bytes32) public contentHash;

    event Minted(address indexed to, uint256 indexed tokenId, string tokenURI, bytes32 contentHash);

    constructor() ERC721("FAWV Vault", "FAVV") Ownable(msg.sender) {}

    function safeMint(address to, string memory uri, bytes32 fileHash) external returns (uint256 tokenId) {
        tokenId = _nextId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        contentHash[tokenId] = fileHash;
        emit Minted(to, tokenId, uri, fileHash);
    }
}
